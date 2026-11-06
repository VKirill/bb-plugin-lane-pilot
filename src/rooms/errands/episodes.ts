import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { renderThreadEvents, threadToolTrace, trajectoryStats, type ThreadEventLike, type ThreadToolTraceEntry } from "@lane-pilot/harness-core";
import { TERMINAL_RUN, type RunRow } from "@lane-pilot/workflow-engine";
import { loadProjectSettings, type LanePilotDatabase } from "../storage";
import { errandOutcome } from "./logic";

/**
 * Errand episodes, phase A (the crystallization foundation, stream R3): the facts of an errand run written by code when
 * the run ends — outcome, verdict, helper thread, model, the skills it was offered and a privacy-safe tool trace. No LLM
 * reads anything here; enrichment is a later stream and `enrichment_state` marks the row pending until then.
 *
 * A run of the `errand` graph is known by `workflow_id`; a run the errand router sent to another graph is known by the
 * pending row `pendingErrandEpisode` writes at start, which `recordErrandEpisode` fills when the run ends. Both go by
 * the composite key (run_id, extractor_version), so a repeated completion event writes nothing twice.
 */
export const ERRAND_EPISODE_TABLE = "lane_pilot_errand_episode";
export const ERRAND_EPISODE_EXTRACTOR_VERSION = 1;
/** Events of the helper thread the trace reads at most (the harness reader pages 100 at a time). */
export const ERRAND_EPISODE_TRACE_EVENTS = 1500;
const DAY_MS = 86_400_000;

type Db = { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown } };

const parse = <T,>(text: string | null | undefined, fallback: T): T => { try { return text ? (JSON.parse(text) as T) : fallback; } catch { return fallback; } };

/** episodes.collect (default on): a project or the global layer may switch the recorder off; nothing is written then. */
function collectEnabled(db: LanePilotDatabase, projectId: string | null): boolean {
  const value = loadProjectSettings(db, projectId ?? GLOBAL_SETTINGS_PROJECT_ID)["episodes.collect"];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
  return true;
}

/** What the `spawn` effect of a run's helper step recorded: the thread and the browser machine, once the thread exists. */
export function errandSpawnOf(db: Db, runId: string): { threadId: string; browserMachine: string | null } | null {
  const row = db.prepare("SELECT result_json FROM lane_pilot_wf_effect WHERE run_id=? AND kind='errand.spawn' AND state='done'").get(runId) as { result_json: string | null } | undefined;
  try { const value = JSON.parse(row?.result_json ?? "null") as { threadId?: unknown; browserMachine?: unknown } | null; return value && typeof value.threadId === "string" ? { threadId: value.threadId, browserMachine: typeof value.browserMachine === "string" ? value.browserMachine : null } : null; } catch { return null; }
}

/**
 * The pending row of a routed errand run (the router sent the errand to another graph): written at start so the
 * completion hook knows the run came from an errand. `recordErrandEpisode` fills it when the run ends.
 */
export function pendingErrandEpisode(db: LanePilotDatabase, input: { runId: string; projectId: string | null; workflowId: string }, log?: (message: string) => void): void {
  try {
    if (!collectEnabled(db, input.projectId)) return;
    const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO ${ERRAND_EPISODE_TABLE}
      (run_id, extractor_version, project_id, workflow_id, status, outcome, enrichment_state, created_at, updated_at)
      VALUES (?,?,?,?,?,?,'pending',?,?)`)
      .run(input.runId, ERRAND_EPISODE_EXTRACTOR_VERSION, input.projectId, input.workflowId, "running", errandOutcome("running", null, null).outcome, now, now);
  } catch (cause) {
    log?.(`Lane Pilot errand episode ${input.runId}: pending row failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export type EpisodeDeps = {
  db: LanePilotDatabase;
  runId: string;
  /** The helper thread's events, oldest first, at most ERRAND_EPISODE_TRACE_EVENTS; absent → the trace stays null. */
  readEvents?: (threadId: string) => Promise<unknown[]>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Writes (or fills) the episode of a finished run. Called fire-and-forget on every workflow event: a run that is not
 * terminal, not an errand's and not already marked pending returns at once; a failure logs one warn line and never
 * touches the run itself.
 */
export async function recordErrandEpisode(deps: EpisodeDeps): Promise<void> {
  const { db, runId } = deps;
  const warn = deps.warn ?? ((message: string) => deps.log?.(message));
  try {
    const run = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(runId) as RunRow | undefined;
    if (!run || !(TERMINAL_RUN as readonly string[]).includes(run.status)) return;
    if (!collectEnabled(db, run.project_id)) return;
    const existing = db.prepare(`SELECT status FROM ${ERRAND_EPISODE_TABLE} WHERE run_id=? AND extractor_version=?`)
      .get(runId, ERRAND_EPISODE_EXTRACTOR_VERSION) as { status: string } | undefined;
    if (existing ? existing.status !== "running" : run.workflow_id !== "errand") return;

    const inputs = parse<Record<string, unknown>>(run.inputs_json, {});
    const output = parse<Record<string, unknown> | null>(run.output_json, null);
    const { outcome } = errandOutcome(run.status, output, run.reason);
    const spawned = errandSpawnOf(db, runId);
    let trace: ThreadToolTraceEntry[] | null = null;
    let traceStats: ReturnType<typeof trajectoryStats> | null = null;
    if (spawned && deps.readEvents) {
      const events = (await deps.readEvents(spawned.threadId)).slice(0, ERRAND_EPISODE_TRACE_EVENTS) as ThreadEventLike[];
      trace = threadToolTrace(events);
      traceStats = trajectoryStats(renderThreadEvents(events));
    }
    const now = Date.now();
    db.prepare(`INSERT INTO ${ERRAND_EPISODE_TABLE}
      (run_id, extractor_version, project_id, workflow_id, status, outcome, verified, checks_json, thread_id, model, provider_id,
       skills_offered_json, trace_json, trace_stats_json, enrichment_state, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)
      ON CONFLICT(run_id, extractor_version) DO UPDATE SET
        project_id=excluded.project_id, workflow_id=excluded.workflow_id, status=excluded.status, outcome=excluded.outcome,
        verified=excluded.verified, checks_json=excluded.checks_json, thread_id=excluded.thread_id, model=excluded.model,
        provider_id=excluded.provider_id, skills_offered_json=excluded.skills_offered_json, trace_json=excluded.trace_json,
        trace_stats_json=excluded.trace_stats_json, updated_at=excluded.updated_at`)
      .run(
        runId, ERRAND_EPISODE_EXTRACTOR_VERSION, run.project_id, run.workflow_id, run.status, outcome,
        output?.verified == null ? null : JSON.stringify(output.verified),
        output?.checks === undefined || output?.checks === null ? null : JSON.stringify(output.checks),
        spawned?.threadId ?? null,
        typeof inputs.model === "string" && inputs.model ? inputs.model : null,
        typeof inputs.providerId === "string" && inputs.providerId ? inputs.providerId : null,
        Array.isArray(inputs.skills) ? JSON.stringify(inputs.skills) : null,
        trace ? JSON.stringify(trace) : null, traceStats ? JSON.stringify(traceStats) : null, now, now,
      );
    deps.log?.(`Lane Pilot errand episode ${runId}: recorded (${outcome})`);
  } catch (cause) {
    warn?.(`errand_episode_failed:${runId}:${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export type EpisodeRow = {
  runId: string; extractorVersion: number; projectId: string | null; workflowId: string; status: string; outcome: string;
  verified: unknown; checks: unknown; threadId: string | null; model: string | null; providerId: string | null;
  skillsOffered: unknown; trace: ThreadToolTraceEntry[] | null;
  traceStats: { actions: number; failedObservations: number; errors: number; userTurns: number } | null;
  enrichmentState: string; createdAt: number; updatedAt: number;
  tokens: number; costUsd: number; waitMs: number; runStartedAt: number; runEndedAt: number;
};

type EpisodeDbRow = {
  run_id: string; extractor_version: number; project_id: string | null; workflow_id: string; status: string; outcome: string;
  verified: string | null; checks_json: string | null; thread_id: string | null; model: string | null; provider_id: string | null;
  skills_offered_json: string | null; trace_json: string | null; trace_stats_json: string | null;
  enrichment_state: string; created_at: number; updated_at: number;
  tokens_used: number; cost_micro_usd: number; wait_ms: number; run_created_at: number; run_updated_at: number;
};

/** The episodes of a period, newest first; cost and run times come from the join on the workflow run. */
export function listEpisodes(db: Db, input: { days: number; projectId?: string | undefined }): EpisodeRow[] {
  const since = Date.now() - input.days * DAY_MS;
  const rows = db.prepare(`
    SELECT e.*, r.tokens_used, r.cost_micro_usd, r.wait_ms, r.created_at AS run_created_at, r.updated_at AS run_updated_at
    FROM ${ERRAND_EPISODE_TABLE} e JOIN lane_pilot_wf_run r ON r.id=e.run_id
    WHERE e.updated_at>=? ${input.projectId ? "AND e.project_id=?" : ""}
    ORDER BY e.updated_at DESC LIMIT 500`).all(since, ...(input.projectId ? [input.projectId] : [])) as EpisodeDbRow[];
  return rows.map((row) => ({
    runId: row.run_id, extractorVersion: row.extractor_version, projectId: row.project_id, workflowId: row.workflow_id,
    status: row.status, outcome: row.outcome,
    verified: row.verified === null ? null : parse<unknown>(row.verified, null),
    checks: parse<unknown>(row.checks_json, null), threadId: row.thread_id, model: row.model, providerId: row.provider_id,
    skillsOffered: parse<unknown>(row.skills_offered_json, null),
    trace: parse<ThreadToolTraceEntry[] | null>(row.trace_json, null),
    traceStats: parse<EpisodeRow["traceStats"]>(row.trace_stats_json, null),
    enrichmentState: row.enrichment_state, createdAt: row.created_at, updatedAt: row.updated_at,
    tokens: row.tokens_used, costUsd: row.cost_micro_usd / 1e6, waitMs: row.wait_ms,
    runStartedAt: row.run_created_at, runEndedAt: row.run_updated_at,
  }));
}
