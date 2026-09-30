import { createHash } from "node:crypto";
import { z } from "zod";
import { parseMemorySettings, searchMemoryRecords, storeMemoryRecords, type MemoryCandidate, type MemorySettings } from "@lane-pilot/memory-core";
import { collectLessonSources, lessonCandidates, parseGoldenCases, routingHint, runGoldenEval, writerAcceptanceStats } from "@lane-pilot/run-insights";
import { loadProjectSettings, type LanePilotDatabase } from "../database";
import { configuredSetting, requirePmRun, type ServerContext } from "./context";

export const INSIGHTS_TOOLS = ["lane_pilot_routing_stats", "lane_pilot_lessons_sweep", "lane_pilot_memory_golden"] as const;

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

export type LessonsSweepResult = { projectId: string; state: "stored" | "nothing_new" | "skipped"; reason?: string; sources: number; candidates: number; stored: number; since: number; until: number };

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
  if (candidates.length === 0) return { ...base, state: "nothing_new", sources: sources.length };
  const sourceSha256 = createHash("sha256").update(sources.map((source) => `${source.runId}/${source.taskId}/${source.at}`).join("\n")).digest("hex");
  const store = (entries: MemoryCandidate[]) => storeMemoryRecords(db, {
    projectId, personalBot: settings.personalBot, audience: "subagent", sourceSha256, entries,
    coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget,
  }).insertedIds.length;
  let stored = 0;
  try {
    stored = store(candidates);
  } catch {
    for (const candidate of candidates) {
      try { stored += store([candidate]); } catch { break; }
    }
  }
  return { ...base, state: "stored", sources: sources.length, candidates: candidates.length, stored };
}

function activeProjects(db: LanePilotDatabase, since: number): string[] {
  const rows = db.prepare("SELECT DISTINCT project_id FROM lane_pilot_run WHERE updated_at>=?").all(since) as Array<{ project_id: string }>;
  return rows.map((row) => row.project_id);
}

export function mountInsights(ctx: ServerContext): void {
  const { bb, db } = ctx;

  bb.agents.registerTool({
    name: "lane_pilot_routing_stats",
    description: "Which provider and model got tasks accepted at the first try in this project, per task risk, with a recommendation.",
    instructions: "Use from the active Lane Pilot PM thread before choosing a writer for a risky task. Statistics need at least five tasks per pair to recommend.",
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

  bb.agents.registerTool({
    name: "lane_pilot_lessons_sweep",
    description: "Turn recent night review findings, rejected acceptances and failed attempts into project memory for future writers, now.",
    instructions: "Use from the active Lane Pilot PM thread. The same sweep also runs on a schedule; calling it twice stores nothing twice.",
    parameters: z.object({ runId: z.string().min(1) }).strict(),
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      return JSON.stringify(await sweepLessons(ctx, context.projectId), null, 2);
    },
  });

  bb.agents.registerTool({
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

  bb.background.schedule("lessons-sweep", "*/15 * * * *", async () => {
    if (ctx.isDisposed()) return;
    const now = Date.now();
    for (const projectId of activeProjects(db, now - 86_400_000)) {
      if (ctx.isDisposed()) return;
      try {
        const result = await sweepLessons(ctx, projectId, now);
        if (result.state === "stored") ctx.log(`Lane Pilot lessons for ${projectId}: ${result.stored} of ${result.candidates} stored from ${result.sources} sources`);
      } catch (cause) {
        ctx.log(`Lane Pilot lessons sweep failed for ${projectId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  });
}
