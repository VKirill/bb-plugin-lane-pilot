import type { LanePilotDatabase } from "../../../storage";
import type { AttemptCursorRow } from "../../models/attempt-metrics";
import { billedFrom } from "../../models/token-math";
import { utcDay, type CursorRow, type DailyTokenAdd, type DailyTokenRow, type ListedThread, type TokenUsageRebuildReset } from "../../models/token-usage";

export function clearTokenUsageTables(db: LanePilotDatabase): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM lane_pilot_token_cursor`).run();
    db.prepare(`DELETE FROM lane_pilot_token_daily`).run();
  })();
}

export function loadCursor(db: LanePilotDatabase, threadId: string): CursorRow {
  const row = db.prepare(`SELECT last_seq, last_json, total_json, last_model, last_provider, last_turn_id
    FROM lane_pilot_token_cursor WHERE thread_id=?`).get(threadId) as CursorRow | undefined;
  return row ?? { last_seq: 0, last_json: "{}", total_json: "{}", last_model: "", last_provider: "", last_turn_id: "" };
}

export function addDaily(db: LanePilotDatabase, row: DailyTokenAdd): void {
  const billed = billedFrom(row.delta);
  if (billed.uncached <= 0 && billed.cacheRead <= 0 && billed.cacheWrite <= 0 && billed.output <= 0 && billed.total <= 0) return;
  db.prepare(`INSERT INTO lane_pilot_token_daily
    (day, project_id, provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens,
     uncached_tokens, cache_read_tokens, cache_write_tokens)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(day, project_id, provider_id, model) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cached_tokens = cached_tokens + excluded.cached_tokens,
      total_tokens = total_tokens + excluded.total_tokens,
      uncached_tokens = uncached_tokens + excluded.uncached_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`)
    .run(row.day, row.projectId, row.providerId, row.model, billed.input, billed.output, billed.cached, billed.total,
      billed.uncached, billed.cacheRead, billed.cacheWrite);
}

export function saveCursor(db: LanePilotDatabase, thread: ListedThread, cursor: CursorRow, now: number): void {
  db.prepare(`INSERT INTO lane_pilot_token_cursor
    (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET
      project_id=excluded.project_id, provider_id=excluded.provider_id, last_seq=excluded.last_seq,
      last_json=excluded.last_json, total_json=excluded.total_json, last_model=excluded.last_model,
      last_provider=excluded.last_provider, last_turn_id=excluded.last_turn_id, updated_at=excluded.updated_at`)
    .run(thread.id, thread.projectId, cursor.last_provider || thread.providerId, cursor.last_seq,
      cursor.last_json, cursor.total_json, cursor.last_model, cursor.last_provider || thread.providerId,
      cursor.last_turn_id, now);
}

export function commitTokenFold(
  db: LanePilotDatabase,
  input: { thread: ListedThread; expectedSeq: number; nextCursor: CursorRow; dailyAdds: readonly DailyTokenAdd[]; now: number },
): boolean {
  let committed = false;
  db.transaction(() => {
    if (loadCursor(db, input.thread.id).last_seq !== input.expectedSeq) return;
    for (const entry of input.dailyAdds) addDaily(db, entry);
    saveCursor(db, input.thread, input.nextCursor, input.now);
    committed = true;
  }).immediate();
  return committed;
}

export function listCursorBreakdowns(db: LanePilotDatabase): Array<{ last_json: string; total_json: string }> {
  return db.prepare(`SELECT last_json, total_json FROM lane_pilot_token_cursor`).all() as Array<{ last_json: string; total_json: string }>;
}

/**
 * First half of a rebuild: copies `lane_pilot_token_daily` and `lane_pilot_token_cursor` to `*_bak_<YYYYMMDD>` tables, then empties both, in one
 * transaction. A backup that already exists (a second rebuild the same day) is kept as it is, so the first one, the state before the rule
 * changed, is never overwritten. The next `syncTokenUsage` re-reads every thread from seq 0 with the current delta rule.
 */
export function resetTokenUsageForRebuild(db: LanePilotDatabase, now = Date.now()): TokenUsageRebuildReset {
  const suffix = utcDay(now).replace(/-/g, "");
  const result: TokenUsageRebuildReset = { backups: [], backupsKept: [], cursorsCleared: 0, dailyRowsCleared: 0 };
  db.transaction(() => {
    for (const table of ["lane_pilot_token_daily", "lane_pilot_token_cursor"]) {
      const backup = `${table}_bak_${suffix}`;
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(backup);
      if (exists) result.backupsKept.push(backup);
      else {
        db.exec(`CREATE TABLE ${backup} AS SELECT * FROM ${table}`);
        result.backups.push(backup);
      }
    }
    result.cursorsCleared = db.prepare(`DELETE FROM lane_pilot_token_cursor`).run().changes;
    result.dailyRowsCleared = db.prepare(`DELETE FROM lane_pilot_token_daily`).run().changes;
  }).immediate();
  return result;
}

export function listDailyUsageRows(db: LanePilotDatabase, from: string, to: string, projectId?: string): DailyTokenRow[] {
  return (projectId
    ? db.prepare(`SELECT day, project_id, provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens,
        uncached_tokens, cache_read_tokens, cache_write_tokens
        FROM lane_pilot_token_daily WHERE day>=? AND day<=? AND project_id=?`).all(from, to, projectId)
    : db.prepare(`SELECT day, project_id, provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens,
        uncached_tokens, cache_read_tokens, cache_write_tokens
        FROM lane_pilot_token_daily WHERE day>=? AND day<=?`).all(from, to)) as DailyTokenRow[];
}

export function listDailyUsageMonths(db: LanePilotDatabase, projectId?: string): string[] {
  const rows = (projectId
    ? db.prepare(`SELECT DISTINCT substr(day,1,7) AS month FROM lane_pilot_token_daily WHERE project_id=? ORDER BY month DESC`).all(projectId)
    : db.prepare(`SELECT DISTINCT substr(day,1,7) AS month FROM lane_pilot_token_daily ORDER BY month DESC`).all()
  ) as Array<{ month: string }>;
  return rows.map((row) => row.month);
}

export function listCursorProviders(db: LanePilotDatabase, projectId?: string): string[] {
  const rows = (projectId
    ? db.prepare(`SELECT DISTINCT provider_id FROM lane_pilot_token_cursor WHERE provider_id!='' AND project_id=?`).all(projectId)
    : db.prepare(`SELECT DISTINCT provider_id FROM lane_pilot_token_cursor WHERE provider_id!=''`).all()) as Array<{ provider_id: string }>;
  return rows.map((row) => row.provider_id);
}

export function listDailyProviders(db: LanePilotDatabase): string[] {
  return (db.prepare(`SELECT DISTINCT provider_id FROM lane_pilot_token_daily`).all() as Array<{ provider_id: string }>)
    .map((row) => row.provider_id);
}

export function lookupThreadCursorMeta(db: LanePilotDatabase, threadId: string): { project_id: string; provider_id: string; last_provider: string } | undefined {
  return db.prepare("SELECT project_id, provider_id, last_provider FROM lane_pilot_token_cursor WHERE thread_id=?")
    .get(threadId) as { project_id: string; provider_id: string; last_provider: string } | undefined;
}

export function loadCursorsByThreadIds(db: LanePilotDatabase, threadIds: readonly string[]): Map<string, AttemptCursorRow> {
  const cursors = new Map<string, AttemptCursorRow>();
  const cursorQuery = db.prepare("SELECT thread_id, provider_id, last_provider, last_model, total_json FROM lane_pilot_token_cursor WHERE thread_id = ?");
  for (const id of threadIds) {
    const row = cursorQuery.get(id) as AttemptCursorRow | undefined;
    if (row) cursors.set(id, row);
  }
  return cursors;
}

/** Today's spend of a project per provider+model (the lane_pilot_facts limit answer). */
export function tokenDailyByModel(db: LanePilotDatabase, projectId: string, day: string): Array<{ provider: string; model: string; tokens: number }> {
  return db.prepare("SELECT provider_id AS provider, model, SUM(total_tokens) AS tokens FROM lane_pilot_token_daily WHERE project_id=? AND day=? GROUP BY provider_id, model ORDER BY tokens DESC")
    .all(projectId, day) as Array<{ provider: string; model: string; tokens: number }>;
}

/** A project's daily spend per provider+model+day since a day (the workers' 30-day bars). */
export function tokenDailySeries(db: LanePilotDatabase, projectId: string, sinceDay: string): Array<{ providerId: string; model: string; day: string; tokens: number }> {
  return db.prepare("SELECT provider_id AS providerId, model, day, SUM(total_tokens) AS tokens FROM lane_pilot_token_daily WHERE project_id=? AND day>=? GROUP BY provider_id, model, day ORDER BY day")
    .all(projectId, sinceDay) as Array<{ providerId: string; model: string; day: string; tokens: number }>;
}

/** A project's whole spend of one day. */
export function tokenDailyTotal(db: LanePilotDatabase, projectId: string, day: string): number {
  return (db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS n FROM lane_pilot_token_daily WHERE project_id=? AND day=?").get(projectId, day) as { n: number }).n;
}

/** A thread's token cursor: provider, last provider/model and the stored totals JSON. */
export function tokenCursorRow(db: LanePilotDatabase, threadId: string): { provider_id: string; last_provider: string; last_model: string; total_json: string } | undefined {
  return db.prepare("SELECT provider_id, last_provider, last_model, total_json FROM lane_pilot_token_cursor WHERE thread_id = ?")
    .get(threadId) as { provider_id: string; last_provider: string; last_model: string; total_json: string } | undefined;
}

// ---- cross-room readers ----

/** Total tokens per project since a day (YYYY-MM-DD), the cost report's spend side. */
export function projectTokenTotalsSince(db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } }, day: string): Array<{ projectId: string; tokens: number }> {
  return db.prepare("SELECT project_id AS projectId, SUM(total_tokens) AS tokens FROM lane_pilot_token_daily WHERE day >= ? GROUP BY project_id")
    .all(day) as Array<{ projectId: string; tokens: number }>;
}

/** Daily token rows since a day, provider/model aliased (the money spend book). */
export function tokenDailyRowsSince(db: LanePilotDatabase, sinceDay: string): Array<{ day: string; providerId: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number }> {
  return db.prepare("SELECT day, provider_id AS providerId, model, input_tokens AS inputTokens, output_tokens AS outputTokens, cached_tokens AS cachedTokens FROM lane_pilot_token_daily WHERE day >= ?")
    .all(sinceDay) as Array<{ day: string; providerId: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number }>;
}

/** The spend book lists a thread from its first second: an empty cursor row, so a thread that dies before any sync still shows with zero totals. */
export function openTokenCursor(db: LanePilotDatabase, input: { threadId: string; projectId: string; providerId: string; at?: number }): void {
  db.prepare("INSERT OR IGNORE INTO lane_pilot_token_cursor (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at) VALUES (?,?,?,0,'{}','{}','','','',?)")
    .run(input.threadId, input.projectId, input.providerId, input.at ?? Date.now());
}
