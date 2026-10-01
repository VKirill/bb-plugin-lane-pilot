import {
  listRuleProposals, saveTriage, triageQuestions, triageState, triageSummary, untriagedAttempts, upsertModelProposal, writerGroups,
  type FailedAttempt, type RuleEvidence, type TriageSummary, type WriterGroup,
} from "@lane-pilot/run-insights";
import { observeStageChild } from "@lane-pilot/thread-observe";
import { loadProjectSettings, loadPrototypeConfig } from "../database";
import { resolveStageWriterSelection } from "../stage-writer-selection";
import { bbServiceTier, writerExecutionSelection } from "../jev-reasoning";
import { refreshRuleProposals } from "./insights";
import { fullAccessSpawn } from "./pm-spawn";
import { stringAt } from "./values";
import { outputText } from "./writer-task";
import type { ServerCore } from "./core";
import type { Services } from "./services";

/** How far back a rescan looks. */
export const RULE_SCAN_WINDOW_MS = 30 * 24 * 3_600_000;
const TRIAGE_CONCURRENCY = 4;
const MAX_GROUPS_PER_SCAN = 4;
const ANALYZER_LIMIT_MS = 20 * 60_000;

export type AnalyzerSelection = { providerId: string; model: string; reasoningLevel: string; serviceTier: "default" | "fast" | null };
export type RuleScanState = {
  state: "idle" | "running" | "done" | "failed";
  startedAt: number | null; finishedAt: number | null;
  triaged: number; groups: number; proposals: number; reason: string | null;
};

const ANALYZER_KEY = (projectId: string) => `rules-analyzer:${projectId}`;
const SCAN_KEY = (projectId: string) => `rules-scan:${projectId}`;
const IDLE: RuleScanState = { state: "idle", startedAt: null, finishedAt: null, triaged: 0, groups: 0, proposals: 0, reason: null };

/** The analyzer's answer: rules with the task ids they stand on, and tasks it found were not the writer's fault. */
export function parseAnalyzerOutput(text: string): { rules: Array<{ rule: string; evidence: string[]; alsoSeen: string[] }>; notWriter: string[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("rules_analyzer_output_not_json");
  const raw = JSON.parse(text.slice(start, end + 1)) as { rules?: unknown; not_writer?: unknown };
  const ids = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string");
  const rules = (Array.isArray(raw.rules) ? raw.rules : []).flatMap((item) => {
    const row = item as { rule?: unknown; evidence?: unknown; also_seen?: unknown };
    return typeof row.rule === "string" && row.rule.trim().length >= 8
      ? [{ rule: row.rule.trim(), evidence: ids(row.evidence), alsoSeen: ids(row.also_seen) }] : [];
  });
  const notWriter = (Array.isArray(raw.not_writer) ? raw.not_writer : []).flatMap((item) => {
    const taskId = (item as { taskId?: unknown }).taskId;
    return typeof taskId === "string" ? [taskId] : [];
  });
  return { rules, notWriter };
}

export function analyzerPrompt(input: { category: string; locale: "ru" | "en"; group: unknown[]; others: unknown[]; rules: string[] }): string {
  return [
    "You are the Lane Pilot rules analyzer. Read-only: do not edit files, do not run commands, answer from the evidence below.",
    `System One sorted these failed writer attempts as the writer's fault, category «${input.category}», each from a different task.`,
    "Find what the writers did wrong in common and write at most three rules that would have prevented it. A rule is one imperative sentence a writer can follow before it finishes a task, specific to this project, not generic advice. Cite only task ids from the evidence.",
    "Then check the other recent writer failures: list in also_seen the task ids where the same mistake happened.",
    "If a failure is not really the writer's fault (Lane Pilot machinery, the environment, a broken task contract), put it in not_writer instead of making a rule from it.",
    `Write the rules in ${input.locale === "ru" ? "Russian" : "English"}.`,
    ...(input.rules.length ? ["Rules the project already has (do not repeat them):", ...input.rules.map((rule) => `- ${rule}`)] : []),
    "Answer with JSON only:",
    '{"rules":[{"rule":"...","evidence":["taskId"],"also_seen":["taskId"]}],"not_writer":[{"taskId":"...","why":"..."}]}',
    "EVIDENCE:", JSON.stringify(input.group),
    "OTHER RECENT WRITER FAILURES:", JSON.stringify(input.others),
  ].join("\n\n");
}

export function createRuleScan(ctx: ServerCore, services: Services) {
  const { bb, db, host } = ctx;
  const running = new Set<string>();

  async function analyzerFor(projectId: string): Promise<AnalyzerSelection | null> {
    const stored = await bb.storage.kv.get(ANALYZER_KEY(projectId)) as AnalyzerSelection | undefined;
    if (stored?.providerId && stored.model) return stored;
    // Until the owner picks one, the analyzer runs on the project's writer model.
    const config = loadPrototypeConfig(db, projectId);
    const { providerId, model } = resolveStageWriterSelection({ settings: loadProjectSettings(db, projectId), config: { writerProviderId: config?.writerProviderId ?? "", writerModel: config?.writerModel ?? "" } });
    return providerId && model ? { providerId, model, reasoningLevel: "high", serviceTier: null } : null;
  }

  async function saveAnalyzer(projectId: string, selection: AnalyzerSelection): Promise<AnalyzerSelection> {
    await bb.storage.kv.set(ANALYZER_KEY(projectId), selection);
    return selection;
  }

  async function scanState(projectId: string): Promise<RuleScanState> {
    return { ...IDLE, ...(await bb.storage.kv.get(SCAN_KEY(projectId)) as Partial<RuleScanState> | undefined) };
  }

  async function setScan(projectId: string, patch: Partial<RuleScanState>): Promise<RuleScanState> {
    const next = { ...await scanState(projectId), ...patch };
    await bb.storage.kv.set(SCAN_KEY(projectId), next);
    return next;
  }

  async function projectPlace(projectId: string): Promise<{ hostId: string; path: string } | null> {
    const resolved = await services.resolveProjectWriterHost({ projectId }).catch(() => null);
    return resolved && resolved.status === "resolved" && resolved.hostId ? { hostId: resolved.hostId, path: resolved.path } : null;
  }

  /**
   * Asks System One about every failed attempt that has no answer for its current reason. Answers are kept, so
   * a rescan pays only for new failures. Stops early when the project's machine has no Jev access.
   */
  async function triageNew(projectId: string, options: { now?: number; limit?: number } = {}): Promise<{ state: "ok" | "no_host" | "jev_unavailable"; triaged: number; reason?: string }> {
    const now = options.now ?? Date.now();
    const pending = untriagedAttempts(db, projectId, now - RULE_SCAN_WINDOW_MS, options.limit ?? 300);
    if (pending.length === 0) return { state: "ok", triaged: 0 };
    const place = await projectPlace(projectId);
    if (!place) return { state: "no_host", triaged: 0 };
    const rules = listRuleProposals(db, projectId).filter((row) => row.state === "accepted" || row.state === "rejected").slice(0, 8);
    const questions = triageQuestions(rules);
    let triaged = 0;
    let unavailable: string | null = null;
    const queue = [...pending];
    const worker = async () => {
      for (let attempt = queue.shift(); attempt && !unavailable && !ctx.isDisposed(); attempt = queue.shift()) {
        const judged = await host.call("councilJudge", {
          requestedHostId: place.hostId, state: JSON.stringify(triageState(attempt)).slice(0, 60_000), questions,
        }, { hostId: place.hostId, timeoutMs: 10_000 }).catch((cause: unknown) => ({ status: "error" as const, answers: {}, confidence: {}, reason: cause instanceof Error ? cause.message : String(cause) }));
        if (judged.status === "disabled") { unavailable = judged.reason ?? "jev_disabled"; return; }
        if (judged.status !== "ok") { saveTriage(db, projectId, attempt, { status: "error", detail: judged.reason ?? judged.status }, now); continue; }
        const answers = judged.answers;
        const confidence = judged.confidence ?? {};
        const ruleIndex = /^r(\d+)$/.exec(answers.same_rule ?? "")?.[1];
        saveTriage(db, projectId, attempt, {
          status: "ok", origin: answers.origin ?? null, originConfidence: confidence.origin ?? null,
          category: answers.category ?? null, categoryConfidence: confidence.category ?? null,
          sameRuleId: ruleIndex ? rules[Number(ruleIndex) - 1]?.id ?? null : null,
        }, now);
        triaged++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRIAGE_CONCURRENCY, pending.length) }, worker));
    return unavailable ? { state: "jev_unavailable", triaged, reason: unavailable } : { state: "ok", triaged };
  }

  /** The pack the analyzer reads for one failure: task contract, reason, critiques, and the tail of the writer's own answer. */
  async function evidenceFor(failure: WriterGroup["failures"][number]): Promise<Record<string, unknown>> {
    const task = db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id=?").get(failure.taskId) as { contract_json: string } | undefined;
    let contract: Record<string, unknown> = {};
    try { contract = JSON.parse(task?.contract_json ?? "{}") as Record<string, unknown>; } catch { /* reason only */ }
    const critiques = (db.prepare(`SELECT stage_id, state, reason, result_json FROM lane_pilot_stage_receipt
      WHERE run_id=? AND task_id=? AND stage_id IN ('plan-critique','code-critique','night-review','verification')`).all(failure.runId, failure.taskId) as Array<{ stage_id: string; state: string; reason: string | null; result_json: string | null }>)
      .map((row) => ({ stage: row.stage_id, state: row.state, reason: row.reason, result: row.result_json?.slice(0, 1500) ?? null }));
    let writerTail: string | null = null;
    if (failure.threadId) {
      const output = await bb.sdk.threads.output({ threadId: failure.threadId }).catch(() => null);
      const text = output ? outputText(output) : "";
      writerTail = text ? text.slice(-2500) : null;
    }
    return {
      taskId: failure.taskId,
      task: { title: contract.title, objective: contract.objective, owns_paths: contract.owns_paths, expected_outputs: contract.expected_outputs, acceptance: contract.acceptance,
        verification: (Array.isArray(contract.verification) ? contract.verification as Array<{ command?: unknown }> : []).map((row) => row.command) },
      failureReason: failure.reason.slice(0, 1500), critiques, writerTail,
    };
  }

  async function analyzeGroup(projectId: string, group: WriterGroup, others: WriterGroup["failures"], place: { hostId: string; path: string }, analyzer: AnalyzerSelection, locale: "ru" | "en"): Promise<number> {
    const evidence = await Promise.all(group.failures.slice(0, 8).map(evidenceFor));
    const prompt = analyzerPrompt({
      category: group.category, locale, group: evidence,
      others: others.filter((row) => !group.failures.some((own) => own.taskId === row.taskId)).slice(0, 40).map((row) => ({ taskId: row.taskId, failureReason: row.reason.slice(0, 300) })),
      rules: listRuleProposals(db, projectId).filter((row) => row.state === "accepted").map((row) => row.rule),
    });
    const spawned = await fullAccessSpawn(bb, {
      projectId, visibility: "hidden", title: `Lane Pilot rules: ${group.category}`,
      ...writerExecutionSelection(analyzer.providerId, analyzer.model, analyzer.reasoningLevel, analyzer.serviceTier ? bbServiceTier(analyzer.serviceTier === "fast" ? "fast" : "standard") : null),
      prompt,
      environment: { type: "host", hostId: place.hostId, workspace: { type: "unmanaged", path: place.path } },
      pluginMetadata: { role: "rules-analyzer", stageId: "rules-analyzer", category: group.category },
    } as Parameters<typeof fullAccessSpawn>[1]);
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("rules_analyzer_thread_id_missing");
    const deadline = Date.now() + ANALYZER_LIMIT_MS;
    let text: string | null = null;
    while (Date.now() < deadline && !ctx.isDisposed()) {
      const observed = await observeStageChild(bb, threadId, 30_000);
      if (observed.kind === "completed") { text = outputText(await bb.sdk.threads.output({ threadId })); break; }
      if (observed.kind === "product_failure") throw new Error(`rules analyzer failed: ${observed.via}:${observed.detail}`);
    }
    if (text === null) {
      await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      throw new Error("rules analyzer did not finish in time");
    }
    const parsed = parseAnalyzerOutput(text);
    const known = new Map([...group.failures, ...others].map((row) => [row.taskId, row]));
    for (const taskId of parsed.notWriter) {
      const row = known.get(taskId);
      if (row) db.prepare("UPDATE lane_pilot_failure_triage SET detail='model:not_writer' WHERE project_id=? AND attempt_id=?").run(projectId, row.attemptId);
    }
    let stored = 0;
    for (const rule of parsed.rules) {
      const cited = [...new Set([...rule.evidence, ...rule.alsoSeen])].flatMap((taskId) => {
        const row = known.get(taskId);
        return row ? [{ runId: row.runId, taskId: row.taskId, attemptId: row.attemptId, reason: row.reason.slice(0, 600) } satisfies RuleEvidence] : [];
      });
      if (cited.length === 0) continue;
      const times = cited.map((ref) => known.get(ref.taskId)!.failedAt);
      upsertModelProposal(db, projectId, { category: group.category, rule: rule.rule, evidence: cited, firstSeenAt: Math.min(...times), lastSeenAt: Math.max(...times) });
      stored++;
    }
    return stored;
  }

  /** The «Rescan» button: triage the last 30 days, then let the analyzer model write rules for each big enough writer group. */
  async function startScan(projectId: string, locale: "ru" | "en"): Promise<{ started: boolean; scan: RuleScanState }> {
    if (running.has(projectId)) return { started: false, scan: await scanState(projectId) };
    running.add(projectId);
    const scan = await setScan(projectId, { state: "running", startedAt: Date.now(), finishedAt: null, triaged: 0, groups: 0, proposals: 0, reason: null });
    void (async () => {
      try {
        const triage = await triageNew(projectId);
        if (triage.state === "jev_unavailable") {
          // Without System One the masked-text grouping is the fallback; it cannot tell whose fault a failure is.
          const fallback = refreshRuleProposals(db, projectId);
          await setScan(projectId, { state: "done", finishedAt: Date.now(), triaged: triage.triaged, proposals: fallback.created, reason: `jev_unavailable:${triage.reason ?? ""}` });
          return;
        }
        if (triage.state !== "ok") {
          await setScan(projectId, { state: "failed", finishedAt: Date.now(), triaged: triage.triaged, reason: triage.reason ?? triage.state });
          return;
        }
        await setScan(projectId, { triaged: triage.triaged });
        const since = Date.now() - RULE_SCAN_WINDOW_MS;
        const groups = writerGroups(db, projectId, since).slice(0, MAX_GROUPS_PER_SCAN);
        await setScan(projectId, { groups: groups.length });
        if (groups.length === 0) { await setScan(projectId, { state: "done", finishedAt: Date.now() }); return; }
        const place = await projectPlace(projectId);
        const analyzer = await analyzerFor(projectId);
        if (!place || !analyzer) {
          await setScan(projectId, { state: "failed", finishedAt: Date.now(), reason: !place ? "no_host" : "no_analyzer_model" });
          return;
        }
        const others = writerGroups(db, projectId, since, { minTasks: 1 }).flatMap((group) => group.failures);
        let proposals = 0;
        for (const group of groups) {
          if (ctx.isDisposed()) return;
          proposals += await analyzeGroup(projectId, group, others, place, analyzer, locale);
          await setScan(projectId, { proposals });
        }
        await setScan(projectId, { state: "done", finishedAt: Date.now(), proposals });
      } catch (cause) {
        await setScan(projectId, { state: "failed", finishedAt: Date.now(), reason: cause instanceof Error ? cause.message : String(cause) }).catch(() => undefined);
      } finally {
        running.delete(projectId);
      }
    })();
    return { started: true, scan };
  }

  function summary(projectId: string): TriageSummary & { pendingGroups: number } {
    const since = Date.now() - RULE_SCAN_WINDOW_MS;
    return { ...triageSummary(db, projectId, since), pendingGroups: writerGroups(db, projectId, since).length };
  }

  /** Every 15 minutes new failures of recently active projects get their System One answers; no model runs. */
  bb.background.schedule("rules-triage", "*/15 * * * *", async () => {
    if (ctx.isDisposed()) return;
    const since = Date.now() - 86_400_000;
    const projects = (db.prepare("SELECT DISTINCT project_id FROM lane_pilot_run WHERE updated_at>=?").all(since) as Array<{ project_id: string }>).map((row) => row.project_id);
    for (const projectId of projects) {
      if (ctx.isDisposed() || running.has(projectId)) continue;
      const result = await triageNew(projectId, { limit: 50 }).catch((cause: unknown) => ({ state: "error", triaged: 0, reason: cause instanceof Error ? cause.message : String(cause) }));
      if (result.triaged > 0 || result.state !== "ok") bb.log.info(`Lane Pilot rules triage for ${projectId}: ${result.state}, ${result.triaged} attempts`);
    }
  });

  return { analyzerFor, saveAnalyzer, scanState, startScan, summary, triageNew };
}

export type RuleScanApi = ReturnType<typeof createRuleScan>;
export type { FailedAttempt };
