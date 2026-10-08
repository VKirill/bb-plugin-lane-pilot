import { z } from "zod";
import { dropMemoryIndexes, memoryRecordId, parseMemorySettings, searchMemoryRecords, storeMemoryRecords, type MemoryCandidate, type MemorySettings } from "@lane-pilot/memory-core";
import {
  collectLessonSources, decideRuleProposal, getRuleProposal, lessonCandidates, listRuleProposals, logRuleEvent, parseGoldenCases, repeatedLessons,
  reviseAdoptedRule, reviseRuleProposal, routingHint, runGoldenEval, setRuleTrial, upsertRuleProposals, writerAcceptanceStats, type RuleProposal,
  upsertLessonProposal, ruleTrialStats,
} from "@lane-pilot/run-insights";
import { loadProjectSettings, type LanePilotDatabase } from "../../storage";
import { configuredSetting, requirePmRun, type ServerContext } from "../../core/server";
import { registerObservedTool } from "../../core/server";
import { scheduleIsolated } from "../../core/server";
import { poolHasRoom, poolTokens, ruleBudget } from "../../learning/rule-budget";
import { sha256Hex } from "@lane-pilot/kit";

export const INSIGHTS_TOOLS = ["lane_pilot_routing_stats", "lane_pilot_lessons_sweep", "lane_pilot_rule_propose", "lane_pilot_lesson", "lane_pilot_memory_golden"] as const;

const MEMORY_KEYS = [
  "memory.enabled", "memory.maintain", "memory.inject", "memory.audience", "memory.personal_bot", "memory.search_engine",
  "memory.core_budget", "memory.note_budget", "memory.index_budget", "memory.context_budget",
];

const LESSONS_SINCE_KEY = (projectId: string) => `lessons:since:${projectId}`;
/** The first sweep of a project looks this far back. */
const FIRST_SWEEP_WINDOW_MS = 30 * 24 * 3_600_000;

export function memorySettingsFor(db: LanePilotDatabase, projectId: string): MemorySettings {
  const settings = loadProjectSettings(db, projectId);
  return parseMemorySettings(Object.fromEntries(MEMORY_KEYS.map((key) => [key, configuredSetting(settings, key)])));
}

export type LessonsSweepResult = {
  projectId: string; state: "counted" | "nothing_new" | "skipped"; reason?: string; sources: number; candidates: number; stored: number; since: number; until: number;
  /** Repeated lessons waiting for the owner to turn them into rules; the PM may reword them with lane_pilot_rule_propose. */
  ruleProposals?: Array<Pick<RuleProposal, "id" | "rule" | "occurrences" | "taskCount" | "examples">>;
};

/** How far back a lesson counts towards a repeated one. */
const RULE_WINDOW_MS = 30 * 24 * 3_600_000;

/** Turns lessons that keep repeating into rule proposals; known proposals keep their wording and decision. */
export function refreshRuleProposals(db: LanePilotDatabase, projectId: string, now = Date.now()): { created: number } {
  return upsertRuleProposals(db, projectId, repeatedLessons(collectLessonSources(db, { projectId, since: now - RULE_WINDOW_MS, limit: 2000 })), now);
}

/**
 * The owner confirms a rule: it becomes a `core` record for the subagent audience, so every writer of the
 * project reads it and CLI exports mark it `always`. The memory budget may refuse it.
 */
export function acceptRuleProposal(db: LanePilotDatabase, projectId: string, id: string, rule: string, by: "owner" | "auto" = "owner", now = Date.now()): RuleProposal {
  const proposal = getRuleProposal(db, projectId, id);
  if (!proposal || proposal.state !== "proposed") throw new Error("rule proposal is not waiting for a decision");
  const settings = memorySettingsFor(db, projectId);
  const content = rule.trim();
  const memoryId = memoryRecordId(projectId, "core", content, settings.personalBot);
  storeMemoryRecords(db, {
    projectId, personalBot: settings.personalBot, audience: "subagent",
    sourceSha256: sha256Hex(`rule:${id}`),
    entries: [{ kind: "core", content, concepts: ["rule", "owner-confirmed"] }],
    coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget,
  });
  if (!decideRuleProposal(db, projectId, id, { from: "proposed", to: "accepted", rule: content, author: content === proposal.rule || by === "auto" ? undefined : "owner", memoryId }, now)) {
    deleteMemoryRecord(db, projectId, memoryId);
    throw new Error("rule proposal was decided elsewhere");
  }
  setRuleTrial(db, projectId, id, by === "auto"
    ? { decidedBy: "auto", trialState: "trial", revisionStartedAt: now }
    : { decidedBy: "owner", trialState: null, revisionStartedAt: now });
  logRuleEvent(db, projectId, id, by === "auto" ? "adopted" : "owner_accepted", null, now);
  return getRuleProposal(db, projectId, id)!;
}

/** A rule on trial this young has not had its chance yet and is not displaced. */
const DISPLACE_AFTER_MS = 3 * 24 * 3_600_000;
/** Writer rules share the writer's brief; PM rules go to the PM chat only, so each side has its own cap. */
const rulePool = (rule: Pick<RuleProposal, "audience">) => rule.audience === "pm" ? "pm" : "writer";

/**
 * The weakest rule of a pool that a new one may replace: on trial (never a confirmed rule or one the owner took), on
 * trial for three days at least; for writers the one given to the fewest attempts, for the PM (no usage is recorded
 * there) the oldest.
 */
function weakestTrialRule(db: LanePilotDatabase, projectId: string, pool: RuleProposal[], now: number): RuleProposal | null {
  const candidates = pool.filter((rule) => rule.trialState === "trial" && rule.decidedBy === "auto"
    && (rule.revisionStartedAt ?? now) <= now - DISPLACE_AFTER_MS);
  const score = (rule: RuleProposal) => rulePool(rule) === "writer" ? ruleTrialStats(db, projectId, rule.id, rule.revisionStartedAt ?? 0).applied : 0;
  return candidates.map((rule) => ({ rule, applied:score(rule) }))
    .sort((a, b) => a.applied - b.applied || (a.rule.revisionStartedAt ?? 0) - (b.rule.revisionStartedAt ?? 0))[0]?.rule ?? null;
}

/**
 * The system adopts a rule: it goes into force on trial, without the owner. When its pool is full it takes the slot of
 * the weakest rule on trial; only when every rule there is confirmed, the owner's or too young does it wait, and the
 * journal says why (it is tried again at start-up and on every rule scan).
 */
export function adoptRuleProposal(db: LanePilotDatabase, projectId: string, id: string, now = Date.now()): RuleProposal | null {
  const proposal = getRuleProposal(db, projectId, id);
  if (!proposal || proposal.state !== "proposed") return null;
  const which = rulePool(proposal);
  const pool = listRuleProposals(db, projectId, { state: "accepted", limit: 500 }).filter((rule) => rulePool(rule) === which);
  // The pool has a budget in tokens (src/learning/rule-budget.ts), not a count of twelve. A rule that does not fit takes the places of
  // the weakest rules on trial, as many as it needs; if the confirmed, the owner's and the too young cannot make room, nothing is touched.
  const victims: RuleProposal[] = [];
  let left = pool;
  while (!poolHasRoom(left, proposal.rule, which)) {
    const weakest = weakestTrialRule(db, projectId, left, now);
    if (!weakest) {
      logRuleEvent(db, projectId, id, "cap_reached", `${pool.length} ${which} rules (${poolTokens(pool)}/${ruleBudget(which)} tokens) in force, none on trial old enough to replace`, now);
      return null;
    }
    victims.push(weakest);
    left = left.filter((rule) => rule.id !== weakest.id);
  }
  for (const weakest of victims) retireAdoptedRule(db, projectId, weakest.id, `displaced by a newer rule (${id})`, now);
  try {
    return acceptRuleProposal(db, projectId, id, proposal.rule, "auto", now);
  } catch (cause) {
    // The project's core memory budget holds the rules with its other conventions; a store that refuses is a full pool all the same.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!/core budget exceeded/.test(message)) throw cause;
    logRuleEvent(db, projectId, id, "cap_reached", `the project's core memory budget has no room for this rule (${message})`, now);
    return null;
  }
}

/** Every waiting rule of every project tries to go on trial again. */
export function adoptWaitingRules(db: LanePilotDatabase, now = Date.now()): number {
  const projects = db.prepare("SELECT DISTINCT project_id FROM lane_pilot_rule_proposal WHERE state='proposed'").all() as Array<{ project_id: string }>;
  let adopted = 0;
  for (const { project_id } of projects) {
    for (const row of listRuleProposals(db, project_id, { state: "proposed", limit: 100 })) if (adoptRuleProposal(db, project_id, row.id, now)) adopted++;
  }
  return adopted;
}

/** Takes a rule out of force on the system's own judgement; the journal keeps the reason. */
export function retireAdoptedRule(db: LanePilotDatabase, projectId: string, id: string, reason: string, now = Date.now()): void {
  const proposal = getRuleProposal(db, projectId, id);
  if (!proposal || proposal.state !== "accepted") return;
  if (!decideRuleProposal(db, projectId, id, { from: "accepted", to: "revoked", memoryId: proposal.memoryId }, now)) return;
  if (proposal.memoryId) deleteMemoryRecord(db, projectId, proposal.memoryId);
  setRuleTrial(db, projectId, id, { trialState: null, retiredReason: reason });
  logRuleEvent(db, projectId, id, "retired", reason, now);
}

/** A rule on trial that did not prevent its mistake gets the analyzer's new wording; the old memory record goes. */
export function rewordAdoptedRule(db: LanePilotDatabase, projectId: string, id: string, rule: string, detail: string, now = Date.now()): boolean {
  const proposal = getRuleProposal(db, projectId, id);
  if (!proposal || proposal.state !== "accepted") return false;
  const settings = memorySettingsFor(db, projectId);
  const content = rule.replace(/\s+/g, " ").trim().slice(0, 600);
  const memoryId = memoryRecordId(projectId, "core", content, settings.personalBot);
  storeMemoryRecords(db, {
    projectId, personalBot: settings.personalBot, audience: "subagent",
    sourceSha256: sha256Hex(`rule:${id}:${proposal.revision + 1}`),
    entries: [{ kind: "core", content, concepts: ["rule", "auto-adopted"] }],
    coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget,
  });
  if (!reviseAdoptedRule(db, projectId, id, content, memoryId, now)) { deleteMemoryRecord(db, projectId, memoryId); return false; }
  if (proposal.memoryId && proposal.memoryId !== memoryId) deleteMemoryRecord(db, projectId, proposal.memoryId);
  setRuleTrial(db, projectId, id, { trialState: "trial" });
  logRuleEvent(db, projectId, id, "revised", detail, now);
  return true;
}

export function rejectRuleProposal(db: LanePilotDatabase, projectId: string, id: string): RuleProposal {
  if (!decideRuleProposal(db, projectId, id, { from: "proposed", to: "rejected" })) throw new Error("rule proposal is not waiting for a decision");
  setRuleTrial(db, projectId, id, { decidedBy: "owner" });
  logRuleEvent(db, projectId, id, "owner_rejected");
  return getRuleProposal(db, projectId, id)!;
}

/** Takes a confirmed rule back: its memory record is removed, so the next writer no longer reads it. */
export function revokeRule(db: LanePilotDatabase, projectId: string, id: string): RuleProposal {
  const proposal = getRuleProposal(db, projectId, id);
  if (!proposal || proposal.state !== "accepted") throw new Error("rule is not accepted");
  if (!decideRuleProposal(db, projectId, id, { from: "accepted", to: "revoked", memoryId: proposal.memoryId })) throw new Error("rule was changed elsewhere");
  if (proposal.memoryId) deleteMemoryRecord(db, projectId, proposal.memoryId);
  setRuleTrial(db, projectId, id, { decidedBy: "owner", trialState: null, retiredReason: "owner" });
  logRuleEvent(db, projectId, id, "owner_revoked");
  return getRuleProposal(db, projectId, id)!;
}

export function deleteMemoryRecord(db: LanePilotDatabase, projectId: string, memoryId: string): void {
  dropMemoryIndexes(db, projectId, memoryId);
  db.prepare("DELETE FROM lane_pilot_memory WHERE project_id=? AND id=?").run(projectId, memoryId);
}

/**
 * Stores what recent receipts teach as `note` records for the subagent audience. Candidates are
 * tried together; when the corpus budget refuses them, they are added one at a time, newest first,
 * until the budget is reached.
 */
export async function sweepLessons(ctx: ServerContext, projectId: string, now = Date.now()): Promise<LessonsSweepResult> {
  const { bb, db } = ctx;
  const since = (await bb.storage.kv.get(LESSONS_SINCE_KEY(projectId)) as number | undefined) ?? now - FIRST_SWEEP_WINDOW_MS;
  const base = { projectId, since, until: now, sources: 0, candidates: 0, stored: 0 };
  let settings: MemorySettings;
  try {
    settings = memorySettingsFor(db, projectId);
  } catch (cause) {
    return { ...base, state: "skipped", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!settings.enabled || !settings.maintain) return { ...base, state: "skipped", reason: "memory_disabled" };
  const sources = collectLessonSources(db, { projectId, since });
  const candidates = lessonCandidates(sources);
  await bb.storage.kv.set(LESSONS_SINCE_KEY(projectId), now);
  const ruleProposals = listRuleProposals(db, projectId, { state: "proposed", limit: 10 })
    .map(({ id, rule, occurrences, taskCount, examples }) => ({ id, rule, occurrences, taskCount, examples }));
  if (candidates.length === 0) return { ...base, state: "nothing_new", sources: sources.length, ruleProposals };
  // Failures are counted, not stored as memory: on the hub they were 82% of the corpus (raw «attempt failed»
  // logs, 2026-10-03 audit) and crowded out knowledge. What repeats reaches writers as a rule instead.
  return { ...base, state: "counted", sources: sources.length, candidates: candidates.length, stored: 0, ruleProposals };
}

function activeProjects(db: LanePilotDatabase, since: number): string[] {
  const rows = db.prepare("SELECT DISTINCT project_id FROM lane_pilot_run WHERE updated_at>=?").all(since) as Array<{ project_id: string }>;
  return rows.map((row) => row.project_id);
}

export function mountInsights(ctx: ServerContext): void {
  const { bb, db } = ctx;

  registerObservedTool(bb.agents, {
    name: "lane_pilot_routing_stats",
    description: "Which provider and model got tasks accepted at the first try in this project, per task risk, with a recommendation.",
    instructions: "Use from the active Lane Pilot PM thread when the owner asks which writer model is accepted most often, or before telling the owner that a risky task type needs another writer in Lane Pilot settings (you cannot pick the model per task). Statistics need at least five tasks per pair to recommend.",
    parameters: z.object({ runId: z.string().min(1), risk: z.enum(["low", "medium", "high", "critical"]).optional(), days: z.number().int().min(1).max(365).default(90) }).strict(),
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      const stats = writerAcceptanceStats(db, { projectId: context.projectId, since: Date.now() - params.days * 86_400_000 });
      const settings = loadProjectSettings(db, context.projectId);
      const provider = configuredSetting(settings, "writer.provider");
      const model = configuredSetting(settings, "writer.model");
      const current = typeof provider === "string" && typeof model === "string" ? { providerId: provider, model } : null;
      const risks = params.risk ? [params.risk] : ["low", "medium", "high", "critical"];
      const hints = Object.fromEntries(risks.map((risk) => [risk, routingHint(stats, current, risk)]).filter(([, hint]) => hint));
      return JSON.stringify({ current, stats, hints }, null, 2);
    },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_lessons_sweep",
    description: "Count recent night review findings, rejected acceptances and failed attempts, and list the ones that keep repeating as rule proposals.",
    instructions: "Use from the active Lane Pilot PM thread. Failures are not stored as memory; what repeats becomes a rule. ruleProposals lists lessons that keep repeating; reword each as one imperative rule with lane_pilot_rule_propose and tell the owner it waits in Lane Pilot settings.",
    parameters: z.object({ runId: z.string().min(1) }).strict(),
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      const swept = await sweepLessons(ctx, context.projectId);
      ctx.realtime?.notify(context.projectId, "rules");
      return JSON.stringify(swept, null, 2);
    },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_rule_propose",
    description: "Reword a repeated lesson as a short rule for future writers. The project owner accepts or rejects it in Lane Pilot settings.",
    instructions: "Use from the active Lane Pilot PM thread with a proposal id from lane_pilot_lessons_sweep. Write one imperative rule that prevents the failure, not a description of it. Only proposals still waiting for the owner can be reworded; accepting is the owner's decision.",
    parameters: z.object({ runId: z.string().min(1), proposalId: z.string().min(1), rule: z.string().min(8).max(600) }).strict(),
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      const revised = reviseRuleProposal(db, context.projectId, params.proposalId, params.rule.trim(), "pm");
      ctx.realtime?.notify(context.projectId, "rules");
      return JSON.stringify({ revised, proposal: getRuleProposal(db, context.projectId, params.proposalId) }, null, 2);
    },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_lesson",
    description: "Record a lesson as a project rule on the hub: the owner corrected you, or an approach got burned.",
    instructions: "Use instead of writing .agents/LESSONS.md, which is not kept any more. Write one imperative rule that prevents the mistake, in English, with evidence (run, task, test, date). `audience`: `pm` for your own work (planning, task contracts, reviewing reports, merging, deploying) — writers never see it; `writer` for how code is edited and checked inside one task; `both` when each must follow it. `always: true` only when the rule holds for every writer task whatever it changes (how to run or read any command); otherwise System One gives it to the tasks it fits. A rule close to a live one counts as its repeat; a new one goes on trial at once: writer rules and PM rules each hold up to 12, and when full the new rule takes the slot of the weakest rule on trial (trial, confirmation and retirement run nightly) — so write only rules that matter. Only after a real correction or landmine — not per session.",
    parameters: z.object({ runId: z.string().min(1), rule: z.string().min(8).max(600), audience: z.enum(["writer", "pm", "both"]), always: z.boolean().default(false),
      evidence: z.string().max(1000).optional(), scope: z.array(z.string()).max(8).optional() }).strict(),
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      const result = upsertLessonProposal(db, context.projectId, { rule: params.rule, evidence: params.evidence, scope: params.scope, audience: params.audience, always: params.always });
      const adopted = result.created ? Boolean(adoptRuleProposal(db, context.projectId, result.id)) : false;
      ctx.realtime?.notify(context.projectId, "rules");
      return JSON.stringify({ ...result, adopted, proposal: getRuleProposal(db, context.projectId, result.id) }, null, 2);
    },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_memory_golden",
    description: "Score project memory retrieval against a golden set of queries and the record ids each must return.",
    instructions: "Use from the active Lane Pilot PM thread after memory changes. `cases` is a JSON array of {query, mustHit} or the `- query -> id1, id2` lines of GOLDEN.yaml.",
    parameters: z.object({ runId: z.string().min(1), cases: z.string().min(1).max(100_000), limit: z.number().int().min(1).max(100).default(20) }).strict(),
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      const settings = memorySettingsFor(db, context.projectId);
      const cases = parseGoldenCases(params.cases);
      const report = runGoldenEval(cases, (query) => searchMemoryRecords(db, context.projectId, query, params.limit, settings.searchEngine, settings.audience, settings.personalBot).map((record) => record.id));
      return JSON.stringify(report, null, 2);
    },
  });

  // Isolated, and off the quarter-hour: BB starts at most 8 isolated runs at once and skips the tick of any further one.
  scheduleIsolated(bb, "lessons-sweep", "4,19,34,49 * * * *", async (signal) => {
    if (ctx.isDisposed()) return;
    const now = Date.now();
    for (const projectId of activeProjects(db, now - 86_400_000)) {
      if (ctx.isDisposed() || signal?.aborted) return;
      try {
        const result = await sweepLessons(ctx, projectId, now);
        if (result.state === "counted") ctx.log(`Lane Pilot lessons for ${projectId}: ${result.candidates} from ${result.sources} sources counted`);
      } catch (cause) {
        ctx.log(`Lane Pilot lessons sweep failed for ${projectId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }, { timeoutMs: 10 * 60_000 });
}
