// The storage room's own tables that answer night and audit questions:
// the model rebench record, the errands' episode table, the janitor's log and daily digests.
import type { LanePilotDatabase } from "./database";

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

export {
  listPilotDayCandidates,
  savePilotDayDigest,
  listPilotDayDigests,
  parseArtifactSkeleton,
} from "./pilot-day-digest-store";
export type {
  PilotDaySourceKind,
  PilotDayCategoryHint,
  PilotDayArtifactSkeleton,
  PilotDayAttemptFact,
  PilotDayStageFact,
  PilotDayEpisodeFact,
  PilotDayChildWfFact,
  PilotDayGateFact,
  PilotDayWfStepFact,
  PilotDayCandidate,
  DirectOwnerChatCandidate,
  PilotDayDigestInput,
  PilotDayDigestRow,
} from "./pilot-day-digest-store";
