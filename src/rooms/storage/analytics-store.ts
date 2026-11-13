import { WF_RUN_TABLE } from "@lane-pilot/workflow-engine";
// The storage room's own tables that answer night and audit questions: the checkers' diff-hidden audit,
// the model rebench record, the errands' episode table, the janitor's log and the bench's stability marks.
import type { LanePilotDatabase } from "./database";

/** One diff-hidden audit row, as the checkers' diff probe records it. */
export type DiffHiddenAuditRow = {
  id: string; runId: string; taskId: string; checker: string;
  withDiffFindings: unknown; diffHiddenFindings: unknown;
  phantom: boolean; blindPass: boolean; diffSensitive: boolean; recordedAt: number;
};

export function saveDiffHiddenRows(db: LanePilotDatabase, rows: readonly DiffHiddenAuditRow[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO lane_pilot_diff_hidden_audit
      (id, run_id, task_id, checker, with_diff_json, diff_hidden_json, phantom, blind_pass, diff_sensitive, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const row of rows) {
      insert.run(
        row.id,
        row.runId,
        row.taskId,
        row.checker,
        JSON.stringify(row.withDiffFindings),
        JSON.stringify(row.diffHiddenFindings),
        row.phantom ? 1 : 0,
        row.blindPass ? 1 : 0,
        row.diffSensitive ? 1 : 0,
        row.recordedAt,
      );
    }
  })();
}

/** The window's diff-hidden audit totals (the checker drill's report). */
export function diffHiddenAuditSummary(db: LanePilotDatabase, sinceMs: number, untilMs: number): {
  candidates: number; total: number; blind_passes: number; phantoms: number; sensitive: number;
} {
  return db.prepare(`
    SELECT
      COUNT(DISTINCT task_id) as candidates,
      COUNT(*) as total,
      COALESCE(SUM(blind_pass), 0) as blind_passes,
      COALESCE(SUM(phantom), 0) as phantoms,
      COALESCE(SUM(diff_sensitive), 0) as sensitive
    FROM lane_pilot_diff_hidden_audit
    WHERE recorded_at >= ? AND recorded_at <= ?
  `).get(sinceMs, untilMs) as { candidates: number; total: number; blind_passes: number; phantoms: number; sensitive: number };
}

/** The episode table's columns on this database (older bases lack the enrichment fields). */
export function errandEpisodeColumns(db: LanePilotDatabase): Set<string> {
  return new Set((db.prepare("PRAGMA table_info(lane_pilot_errand_episode)").all() as Array<{ name: string }>).map((column) => column.name));
}

/** The group's episode facts, one batched read per chunk of run ids; run_id -> row (first version wins). */
export function listErrandEpisodeFacts(db: LanePilotDatabase, runIds: readonly string[], columns: { processKey: boolean; processKeyProposed: boolean; provider: boolean; model: boolean }): Map<string, Record<string, string | null>> {
  const facts = new Map<string, Record<string, string | null>>();
  if (!runIds.length || (!columns.processKey && !columns.processKeyProposed && !columns.provider && !columns.model)) return facts;
  const fields = ["run_id", ...(columns.processKey ? ["process_key"] : []), ...(columns.processKeyProposed ? ["process_key_proposed"] : []), ...(columns.provider ? ["provider_id"] : []), ...(columns.model ? ["model"] : [])];
  for (let at = 0; at < runIds.length; at += 400) {
    const chunk = runIds.slice(at, at + 400);
    const rows = db.prepare(`SELECT ${fields.join(", ")} FROM lane_pilot_errand_episode WHERE run_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<Record<string, string | null>>;
    for (const row of rows) {
      const runId = row.run_id;
      if (typeof runId !== "string" || facts.has(runId)) continue;
      facts.set(runId, row);
    }
  }
  return facts;
}

/** Trace json of the group's episodes, same chunked read; run_id -> raw trace json. */
export function listErrandEpisodeTraces(db: LanePilotDatabase, runIds: readonly string[]): Map<string, string | null> {
  const traces = new Map<string, string | null>();
  for (let at = 0; at < runIds.length; at += 400) {
    const chunk = runIds.slice(at, at + 400);
    const rows = db.prepare(`SELECT run_id, trace_json FROM lane_pilot_errand_episode WHERE run_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<{ run_id: string; trace_json: string | null }>;
    for (const row of rows) {
      if (traces.has(row.run_id)) continue;
      traces.set(row.run_id, row.trace_json);
    }
  }
  return traces;
}

/** Episodes still waiting for enrichment, oldest first (the sweep's work list; the join keeps orphans out of the limit). */
export function listPendingErrandEpisodes(db: LanePilotDatabase, staleBefore: number, limit: number): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT e.run_id, e.project_id, e.status, e.outcome, e.verified, e.thread_id, e.model, e.skills_offered_json,
      e.trace_json, e.trace_stats_json, r.reason AS run_reason, r.inputs_json AS run_inputs
    FROM lane_pilot_errand_episode e JOIN ${WF_RUN_TABLE} r ON r.id=e.run_id
    WHERE (e.enrichment_state='pending' AND (e.enriched_at IS NULL OR e.enriched_at < ?))
      OR (e.enrichment_state='held' AND e.updated_at < ?)
    ORDER BY e.created_at ASC LIMIT ?`).all(staleBefore, staleBefore, limit) as Array<Record<string, unknown>>;
}

/** Process keys with their run's inputs, newest episodes first (the enricher's known processes). */
export function listErrandProcessKeys(db: LanePilotDatabase, limit: number): Array<{ key: string; inputs_json: string | null }> {
  return db.prepare(`SELECT e.process_key AS key, r.inputs_json FROM lane_pilot_errand_episode e JOIN ${WF_RUN_TABLE} r ON r.id=e.run_id
    WHERE e.process_key IS NOT NULL ORDER BY e.created_at DESC LIMIT ?`).all(limit) as Array<{ key: string; inputs_json: string | null }>;
}

/** Episodes of a window with their run's cost and timing (the episode list; the join keeps orphans out of the limit). */
export function listErrandEpisodeRows(db: LanePilotDatabase, since: number, projectId: string | null, limit: number): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT e.*, r.tokens_used, r.cost_micro_usd, r.wait_ms, r.created_at AS run_created_at, r.updated_at AS run_updated_at
    FROM lane_pilot_errand_episode e JOIN ${WF_RUN_TABLE} r ON r.id=e.run_id
    WHERE e.updated_at>=? ${projectId ? "AND e.project_id=?" : ""}
    ORDER BY e.updated_at DESC LIMIT ?`).all(since, ...(projectId ? [projectId] : []), limit) as Array<Record<string, unknown>>;
}

/** Every episode's run_id and status (the missing-episode filter of the outcome backfill). */
export function listErrandEpisodeStates(db: LanePilotDatabase): Array<{ run_id: string; status: string }> {
  return db.prepare("SELECT run_id, status FROM lane_pilot_errand_episode").all() as Array<{ run_id: string; status: string }>;
}

/** Run ids that have an episode row (the diagnosis' routed-errand join). */
export function listErrandEpisodeRunIds(db: LanePilotDatabase): Set<string> {
  return new Set((db.prepare("SELECT run_id FROM lane_pilot_errand_episode").all() as Array<{ run_id: string }>).map((row) => row.run_id));
}

/** The janitor's freed bytes and removals of a window (the morning line). */
export function janitorSums(db: LanePilotDatabase, since: number): { bytes: number | null; removed: number | null } {
  return db.prepare("SELECT sum(freed_bytes + tmp_freed_bytes) AS bytes, sum(removed + tmp_removed) AS removed FROM lane_pilot_janitor WHERE at>=?")
    .get(since) as { bytes: number | null; removed: number | null };
}

/** The janitor's kept copies of a window, up to three, with the total (the morning line). */
export function janitorKeptSample(db: LanePilotDatabase, since: number): Array<{ v: string; total: number }> {
  return db.prepare("SELECT value AS v, (SELECT count(*) FROM lane_pilot_janitor j2, json_each(j2.kept_json) WHERE j2.at>=?) AS total FROM lane_pilot_janitor, json_each(lane_pilot_janitor.kept_json) WHERE at>=? LIMIT 3")
    .all(since, since) as Array<{ v: string; total: number }>;
}

/** Stability marks of a bench set: upserts the given marks, drops the given tasks. */
export function saveBenchStabilityMarks(db: LanePilotDatabase, input: { setId: string; marks: ReadonlyMap<string, string>; dropIds: readonly string[]; detail: unknown; now?: number }): void {
  const now = input.now ?? Date.now();
  const detail = JSON.stringify(input.detail ?? {});
  const upsert = db.prepare("INSERT INTO lane_pilot_bench_mark(set_id,task_id,mark,detail_json,marked_at) VALUES(?,?,?,?,?) ON CONFLICT(set_id,task_id) DO UPDATE SET mark=excluded.mark, detail_json=excluded.detail_json, marked_at=excluded.marked_at");
  for (const [taskId, mark] of input.marks) upsert.run(input.setId, taskId, mark, detail, now);
  const drop = db.prepare("DELETE FROM lane_pilot_bench_mark WHERE set_id=? AND task_id=?");
  for (const taskId of input.dropIds) drop.run(input.setId, taskId);
}

/** Stability marks of a bench set, task_id -> mark. */
export function listBenchStabilityMarks(db: LanePilotDatabase, setId: string): Map<string, string> {
  const rows = db.prepare("SELECT task_id, mark FROM lane_pilot_bench_mark WHERE set_id=?").all(setId) as Array<{ task_id: string; mark: string }>;
  return new Map(rows.map((row) => [row.task_id, row.mark]));
}

/** The newest extractor's episode row per run id (the diagnosis' episode fields). */
export function latestErrandEpisodeRows(db: LanePilotDatabase, runIds: readonly string[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (let at = 0; at < runIds.length; at += 400) {
    const chunk = runIds.slice(at, at + 400);
    if (!chunk.length) break;
    const rows = db.prepare(`SELECT * FROM lane_pilot_errand_episode e WHERE e.run_id IN (${chunk.map(() => "?").join(",")})
      AND e.extractor_version = (SELECT MAX(e2.extractor_version) FROM lane_pilot_errand_episode e2 WHERE e2.run_id = e.run_id)`).all(...chunk) as Array<Record<string, unknown>>;
    for (const row of rows) map.set(String(row.run_id), row);
  }
  return map;
}
