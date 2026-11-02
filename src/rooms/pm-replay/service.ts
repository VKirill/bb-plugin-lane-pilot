import { readFileSync } from "node:fs";
import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { getRuleProposal, logRuleEvent, setRuleTrial } from "@lane-pilot/run-insights";
import { adoptRuleProposal, SELF_REPAIR_DEFAULTS } from "../self-repair/server";
import { isSandboxProjectName } from "../stability/server";
import { postOwnerItem } from "../owner-waiting";
import { registeredTools, scheduleIsolated, type ServerCore, type Services } from "../core/server";
import { builtinWorkflow } from "../workflow";
import type { ChainRuntime } from "../workflow/server";
import { startOfDay, type Db } from "../learning";
import { correctionObservations, harvestPrompt, importScenarios, parseHarvested, pmThreadIds } from "./harvest";
import { decideReplay, replayLine, type ArmVerdict } from "./decide";
import { armId, armPrompt, pmSurfaceTools } from "./surface";
import { stageBundle, runScenario } from "./runner";
import { getScenario, insertResult, insertScenario, latestVerdicts, linkScenariosToRule, listScenarios, replayStats, retireScenario } from "./store";

export const PM_REPLAY_WORKFLOW = "lp.pm-replay";
export const PM_REPLAY_SCHEDULE = "pm-replay-nightly";

/** Per-night bounds: no night may harvest more scenarios or spend more dollars than this, whatever happens. */
export const HARVEST_CAP = 20;
export const NIGHT_COST_CAP_USD = 6;
const DAY_MS = 86_400_000;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");

type RunDeps = {
  hostId: string;
  runModel(prompt: string, projectId: string, label: string): Promise<string>;
};

/** What a run of the replay produces; the same functions serve the graph steps and `bb lane-pilot pm-replay run`. */
export function createPmReplay(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  const kv = bb.storage.kv as unknown as { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };
  const host = ctx as unknown as Parameters<typeof stageBundle>[0] extends never ? never : import("@lane-pilot/host-calls").RunCommandHost;

  const tools = () => pmSurfaceTools(registeredTools(bb.agents));
  const toolNames = () => tools().map((tool) => tool.name);

  async function runModel(prompt: string, projectId: string, label: string): Promise<string> {
    const place = await services.resolveProjectWriterHost({ projectId: projectId === "*" ? SELF_REPAIR_DEFAULTS.projectId : projectId } as never).catch(() => null);
    if (!place || (place as { status?: string }).status !== "resolved") throw new Error("no_host");
    const analyzer = await services.ruleScan.analyzerFor(projectId, { hostId: (place as { hostId: string }).hostId, path: (place as { path: string }).path });
    if (!analyzer) throw new Error("no_analyzer_model");
    return await services.ruleScan.runAnalyzer(projectId, `PM replay · ${label}`.slice(0, 160), prompt, { hostId: (place as { hostId: string }).hostId, path: (place as { path: string }).path }, analyzer, { learning: true });
  }

  async function replayHost(projectId: string): Promise<string | null> {
    const place = await services.resolveProjectWriterHost({ projectId: projectId === "*" ? SELF_REPAIR_DEFAULTS.projectId : projectId } as never).catch(() => null);
    return place && (place as { status?: string }).status === "resolved" ? (place as { hostId: string }).hostId : null;
  }

  /** Sandbox/drill project ids, for the harvest's skip. */
  async function sandboxIds(): Promise<Set<string>> {
    try {
      const rows = await bb.sdk.projects.list({ includePersonal: true }) as Array<{ id: string; name?: string }>;
      return new Set(rows.filter((row) => isSandboxProjectName(row.name)).map((row) => row.id));
    } catch { return new Set(); }
  }

  /** Night step 1: corrections of the last 24 h become scenarios (cap HARVEST_CAP, sandbox projects skipped). */
  async function harvest(sinceMs = DAY_MS, cap = HARVEST_CAP): Promise<{ harvested: number; seen: number; scenarios: string[] }> {
    const since = Date.now() - sinceMs;
    const threads = pmThreadIds(db, since);
    if (!threads.size) return { harvested: 0, seen: 0, scenarios: [] };
    const sandbox = await sandboxIds();
    const candidates = correctionObservations(db, threads, since, cap * 2).filter((row) => !sandbox.has(row.projectId));
    const out: string[] = [];
    let seen = 0;
    for (const obs of candidates) {
      if (out.length >= cap || ctx.isDisposed()) break;
      seen += 1;
      try {
        const reply = await runModel(harvestPrompt({ project: obs.projectId, ownerMessage: obs.ownerMessage, prevReply: obs.prevReply, tools: toolNames() }), obs.projectId, `harvest ${obs.obsId}`);
        const scenario = parseHarvested(reply, { obsId: obs.obsId, threadId: obs.threadId, projectId: obs.projectId, at: obs.at, ownerMessage: obs.ownerMessage, tools: toolNames() }, Date.now());
        if (scenario && insertScenario(db, scenario)) out.push(scenario.id);
      } catch (cause) {
        ctx.log(`pm-replay: harvest of ${obs.obsId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    await kv.set("pm-replay:last-harvest" as never, { at: Date.now(), harvested: out.length, seen } as never);
    return { harvested: out.length, seen, scenarios: out };
  }

  /**
   * Night step 2 + `pm-replay run`: replay scenarios on the base arm and, with `ruleId`, on the candidate arm
   * (base prompt + that rule's text appended). `retryIds` re-runs those scenarios a second sample. Returns the count.
   */
  async function replay(input: { ruleId?: string; scenarioIds?: readonly string[]; samples?: Record<string, number>; projectId?: string } = {}): Promise<{ ran: number; costUsd: number; arm: string; error?: string }> {
    const projectId = input.projectId ?? "*";
    const hostId = await replayHost(projectId);
    if (!hostId) return { ran: 0, costUsd: 0, arm: "", error: "no host resolved" };
    const rule = input.ruleId ? getRuleProposal(db as never, projectId === "*" ? (listScenarios(db, { ruleId: input.ruleId })[0]?.projectId ?? projectId) : projectId, input.ruleId) : null;
    if (input.ruleId && !rule) return { ran: 0, costUsd: 0, arm: "", error: `rule ${input.ruleId} not found` };
    const ruleProject = rule ? (listScenarios(db, { ruleId: input.ruleId })[0]?.projectId ?? projectId) : projectId;
    const basePrompt = armPrompt(db, ruleProject === "*" ? "*" : ruleProject);
    const candPrompt = rule ? armPrompt(db, ruleProject === "*" ? "*" : ruleProject, [{ rule: rule.rule }]) : null;
    const arms: Record<string, string> = { base: basePrompt, ...(candPrompt ? { cand: candPrompt } : {}) };
    const incidents = input.ruleId ? listScenarios(db, { ruleId: input.ruleId }).filter((s) => s.state === "active") : [];
    let scenarios = input.scenarioIds?.length
      ? input.scenarioIds.map((id) => getScenario(db, id)).filter((s): s is NonNullable<typeof s> => Boolean(s))
      : [...incidents, ...listScenarios(db, { state: "active" }).filter((s) => !incidents.some((i) => i.id === s.id))];
    if (!scenarios.length) return { ran: 0, costUsd: 0, arm: "", error: "no scenarios" };
    const staged = await stageBundle(host as never, { hostId, surface: { tools: tools() }, arms, scenarios });
    if ("error" in staged) return { ran: 0, costUsd: 0, arm: "", error: staged.error };
    const baseArm = armId(basePrompt);
    const candArm = candPrompt ? armId(candPrompt, [input.ruleId!]) : null;
    // The cap is per day across every replay call of the night, not per call: a night with several candidate rules stays under it.
    const spentToday = replayStats(db, Date.now() - DAY_MS).costUsd;
    if (spentToday >= NIGHT_COST_CAP_USD) return { ran: 0, costUsd: 0, arm: "", error: `day cap $${NIGHT_COST_CAP_USD} spent ($${spentToday.toFixed(2)})` };
    let ran = 0, cost = spentToday;
    const record = async (scenarioId: string, arm: string, sample: number) => {
      const result = await runScenario(host as never, { hostId, dir: staged.dir, arm: arm === baseArm ? "base" : "cand", scenarioId, sample });
      insertResult(db, { scenarioId, arm, sample, verdict: result.verdict, why: result.why, calls: result.calls, costUsd: result.costUsd, at: Date.now() });
      ran += 1; cost += result.costUsd;
    };
    // Incidents first on both arms; the rest of the set only once they pass — and only the candidate needs re-runs.
    for (const scenario of scenarios) {
      if (cost >= NIGHT_COST_CAP_USD || ctx.isDisposed()) break;
      const isIncident = incidents.some((i) => i.id === scenario.id);
      const sample = input.samples?.[scenario.id] ?? 1;
      if (!latestVerdicts(db, { arm: baseArm }).has(scenario.id) || isIncident) await record(scenario.id, baseArm, sample);
      if (candArm && (isIncident || incidentVerdictsPass(db, candArm, incidents.map((i) => i.id)))) await record(scenario.id, candArm, sample);
    }
    return { ran, costUsd: cost - spentToday, arm: candArm ?? baseArm };
  }

  /** Stage-2 gate inside replay(): the whole set runs on the candidate only once every incident scenario passed it. */
  function incidentVerdictsPass(db: Db, arm: string, ids: readonly string[]): boolean {
    if (!ids.length) return true;
    const verdicts = latestVerdicts(db, { arm });
    return ids.every((id) => verdicts.get(id)?.verdict === "PASS");
  }

  /** Night step 3: decide the rules on trial that now have a candidate arm, then adopt or keep — never asks the owner. */
  async function decide(input: { ruleId?: string } = {}): Promise<{ adopted: number; rejected: number; waited: number; lines: string[] }> {
    const ruleIds = input.ruleId
      ? [input.ruleId]
      : [...new Set(listScenarios(db, { state: "active" }).map((s) => s.ruleId).filter((v): v is string => Boolean(v)))];
    const lines: string[] = [];
    let adopted = 0, rejected = 0, waited = 0;
    for (const ruleId of ruleIds) {
      const incidents = listScenarios(db, { ruleId }).filter((s) => s.state === "active").map((s) => s.id);
      if (!incidents.length) continue;
      const projectId = getScenario(db, incidents[0]!)?.projectId ?? "*";
      const baseArm = armId(armPrompt(db, projectId));
      const rule = getRuleProposal(db as never, projectId, ruleId);
      if (!rule) continue;
      const candArm = armId(armPrompt(db, projectId, [{ rule: rule.rule }]), [ruleId]);
      const fold = (map: Map<string, { verdict: string; why: string | null; at: number; sample: number }>) => {
        const out = new Map<string, ArmVerdict>();
        for (const [k, v] of map) {
          const [id, sample2] = k.includes("#") ? k.split("#") as [string, string] : [k, ""];
          if (v.sample >= 2) out.set(`${id}#2`, { verdict: v.verdict, sample: v.sample });
          else if (!out.has(id!)) out.set(id!, { verdict: v.verdict, sample: v.sample });
          void sample2;
        }
        return out;
      };
      const decision = decideReplay({
        incidentIds: incidents,
        base: fold(latestVerdicts(db, { arm: baseArm })),
        candidate: fold(latestVerdicts(db, { arm: candArm })),
        activeIds: listScenarios(db, { state: "active" }).map((s) => s.id),
      });
      if (decision.action === "adopt") {
        if (rule.state !== "accepted") adoptRuleProposal(db as never, projectId, ruleId);
        setRuleTrial(db as never, projectId, ruleId, { trialState: "confirmed", decidedBy: "auto" });
        logRuleEvent(db as never, projectId, ruleId, "confirmed", `pm-replay: ${decision.reason}`);
        postOwnerItem(db as never, { key: `pm-replay:${ruleId}:${new Date().toISOString().slice(0, 10)}`, source: "pm-replay", kind: "note", projectId, wake: false,
          what: `PM rule proven on the replay set and confirmed: ${rule.rule.slice(0, 200)}`, why: decision.reason.slice(0, 400) });
        adopted += 1; lines.push(`adopted ${ruleId}: ${decision.reason}`);
      } else if (decision.action === "reject") {
        if (decision.retireIncident) {
          setRuleTrial(db as never, projectId, ruleId, { retiredReason: `pm-replay: ${decision.reason}` });
          logRuleEvent(db as never, projectId, ruleId, "retired", `pm-replay: ${decision.reason}`);
        }
        rejected += 1; lines.push(`rejected ${ruleId}: ${decision.reason}`);
      } else {
        waited += 1; lines.push(`${decision.action} ${ruleId}: ${decision.reason}`);
      }
    }
    return { adopted, rejected, waited, lines };
  }

  /** `pm-replay import <file>`: seed the set from a scenarios.json/scenarios-real.json file. */
  function importFile(path: string, projectId = "*"): { imported: number; skipped: number; ids: string[] } {
    const rows = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
    const now = Date.now();
    const ids: string[] = [];
    let skipped = 0;
    for (const scenario of importScenarios(Array.isArray(rows) ? rows : [], projectId, now)) {
      if (insertScenario(db, scenario)) ids.push(scenario.id); else skipped += 1;
    }
    return { imported: ids.length, skipped, ids };
  }

  /** `pm-replay status`: last night's numbers and the set's state. */
  async function status(): Promise<Record<string, unknown>> {
    const last = (await kv.get<{ at: number; harvested: number; seen: number }>("pm-replay:last-harvest" as never).catch(() => null)) ?? null;
    const stats = replayStats(db, startOfDay(Date.now()));
    return {
      lastHarvest: last,
      today: stats,
      scenarios: { active: listScenarios(db, { state: "active" }).length, retired: listScenarios(db, { state: "retired" }).length },
      line: replayLine({ harvested: last?.harvested ?? 0, ran: stats.runs, adopted: 0, rejected: 0, costUsd: stats.costUsd }),
    };
  }

  return { harvest, replay, decide, importFile, status, linkScenariosToRule: (ids: readonly string[], ruleId: string) => linkScenariosToRule(db, ids, ruleId), retireScenario: (id: string) => retireScenario(db, id), toolNames };
}
export type PmReplay = ReturnType<typeof createPmReplay>;

/** The night graph's executors and its cron (04:20 UTC, after the jev labels at 03:45). */
export function mountPmReplay(ctx: ServerCore, services: Services): PmReplay {
  const engine = services.workflowEngine;
  const replay = createPmReplay(ctx, services);
  const input = (c: StepContext<ChainRuntime>, name: string): string => text(c.resolve(`$inputs.${name}`));

  engine.register<ChainRuntime>("lp.pm_replay_harvest", {
    reentrant: true,
    run: async () => ({ output: { status: "done", ...(await replay.harvest()) } }),
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.pm_replay_run", {
    reentrant: true,
    run: async (c) => ({ output: { status: "done", ...(await replay.replay({ ruleId: input(c, "rule_id") || undefined })) } }),
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.pm_replay_decide", {
    reentrant: true,
    run: async () => {
      const result = await replay.decide();
      for (const line of result.lines) ctx.log(`pm-replay: ${line}`);
      return { output: { status: "done", ...result, summary: result.lines.join("\n") } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.pm_replay_report", {
    reentrant: true,
    run: async (c) => {
      const harvested = c.resolve("harvest.harvested") as number | undefined;
      const ran = c.resolve("run.ran") as number | undefined, cost = c.resolve("run.costUsd") as number | undefined;
      const adopted = c.resolve("decide.adopted") as number | undefined, rejected = c.resolve("decide.rejected") as number | undefined;
      const summary = replayLine({ harvested: harvested ?? 0, ran: ran ?? 0, adopted: adopted ?? 0, rejected: rejected ?? 0, costUsd: cost ?? 0 });
      ctx.log(summary);
      return { output: { status: "done", summary } };
    },
  } as NodeExecutor<ChainRuntime>);

  scheduleIsolated(ctx.bb, PM_REPLAY_SCHEDULE, "20 4 * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const workflow = builtinWorkflow(PM_REPLAY_WORKFLOW);
    if (!workflow) return;
    const key = `pm-replay:${new Date().toISOString().slice(0, 10)}`;
    if (ctx.db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(key)) return;
    await engine.start({
      workflow, key, link: { projectId: "*" },
      runtime: { ctx, services, pmThreadId: null, projectId: "*", runId: null, origin: "schedule" } satisfies ChainRuntime,
      inputs: {},
    }).done.catch((cause: unknown) => ctx.log(`pm-replay nightly failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 90 * 60_000 });

  return replay;
}
