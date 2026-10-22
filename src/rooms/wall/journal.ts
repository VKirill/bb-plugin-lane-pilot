import type Database from "better-sqlite3";
import { logOrigin, logSignature, originOf, wallSignature } from "./signature";
import { EMPTY_SOURCES, RUNGS, type Sources, type WallClass } from "./types";

export type WallDb = Pick<Database.Database, "prepare" | "transaction">;

/** Attempt states that are a failure of the attempt (the canary's list plus the two older names). */
export const FAILED_STATES = ["blocked", "provider_error", "timeout", "empty_output", "validation_failed", "spawn_rejected", "failed", "rejected"] as const;
/** An attempt still in flight has neither succeeded nor failed (the same rule as scripts/lp-metrics-views.sql). */
const IN_FLIGHT = ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"] as const;
const quoted = (list: readonly string[]) => list.map((item) => `'${item}'`).join(",");

const DAY = 86_400_000;
export const nightOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

export type JournalOptions = {
  /** The window of the night, [since, until). */
  since: number;
  until: number;
  /** Whether a failure counts: sandbox, bench and drill traffic fails on purpose and is left out. */
  isReal: (projectId: string, taskId: string) => boolean;
  /** Failure lines of the plugin log (self-repair's `logIncidents`) inside the window. */
  logLines?: ReadonlyArray<{ message: string; at: number; projectId: string }>;
  now?: number;
};

export type EntryKey = { classKey: string; version: string; projectId: string };
export type Entry = EntryKey & {
  night: string; failureClass: string; reasonNorm: string; origin: string;
  n: number; tasks: number; sources: Sources; gates: Record<string, number>; stages: Record<string, number>;
  samples: string[]; firstAt: number; lastAt: number;
};

type FailedRow = { id: string; run_id: string; task_id: string; state: string; reason: string | null; updated_at: number; harness_version: string | null; project_id: string; triage_origin: string | null };

/**
 * One night's failures grouped by signature (failure class, normalised reason) x LP version x project. Four sources: the attempt itself,
 * its failure triage (the origin), the gate events and the stage receipts of its task (where it broke), and the plugin log's failure lines.
 */
export function collectEntries(db: WallDb, options: JournalOptions): Entry[] {
  const rows = db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.updated_at, a.harness_version, r.project_id, t.origin AS triage_origin
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    LEFT JOIN lane_pilot_failure_triage t ON t.attempt_id=a.id AND t.project_id=r.project_id AND t.status='ok'
    WHERE a.updated_at>=? AND a.updated_at<? AND a.state IN (${quoted(FAILED_STATES)})
    ORDER BY a.updated_at`).all(options.since, options.until) as FailedRow[];
  const gates = db.prepare("SELECT gate, status, count(*) AS n FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? AND status IN ('rejected','failed') GROUP BY gate, status");
  const stages = db.prepare("SELECT stage_id, count(*) AS n FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND state IN ('failed','blocked') GROUP BY stage_id");
  const night = nightOf(options.until - 1);
  const map = new Map<string, Entry & { taskSet: Set<string> }>();
  const slot = (key: EntryKey, make: () => Omit<Entry, "n" | "tasks" | "sources" | "gates" | "stages" | "samples" | "night" | "firstAt" | "lastAt">, at: number) => {
    const id = `${key.classKey}|${key.version}|${key.projectId}`;
    let entry = map.get(id);
    if (!entry) {
      entry = { ...make(), night, n: 0, tasks: 0, sources: { ...EMPTY_SOURCES }, gates: {}, stages: {}, samples: [], firstAt: at, lastAt: at, taskSet: new Set() };
      map.set(id, entry);
    }
    entry.firstAt = Math.min(entry.firstAt, at);
    entry.lastAt = Math.max(entry.lastAt, at);
    return entry;
  };
  for (const row of rows) {
    if (!options.isReal(row.project_id, row.task_id)) continue;
    const sig = wallSignature(row.state, row.reason);
    const origin = originOf(sig.failureClass, row.triage_origin);
    const key = { classKey: sig.classKey, version: row.harness_version ?? "", projectId: row.project_id };
    const entry = slot(key, () => ({ ...key, failureClass: sig.failureClass, reasonNorm: sig.reasonNorm, origin }), row.updated_at);
    entry.n += 1;
    entry.taskSet.add(`${row.run_id}:${row.task_id}`);
    entry.sources.attempt += 1;
    if (row.triage_origin) entry.sources.triage += 1;
    if (entry.samples.length < 6) entry.samples.push(row.id);
    const gateRows = gates.all(row.run_id, row.task_id) as Array<{ gate: string; status: string; n: number }>;
    if (gateRows.length) entry.sources.gate += 1;
    for (const gate of gateRows) entry.gates[`${gate.gate}:${gate.status}`] = (entry.gates[`${gate.gate}:${gate.status}`] ?? 0) + gate.n;
    const stageRows = stages.all(row.run_id, row.task_id) as Array<{ stage_id: string; n: number }>;
    if (stageRows.length) entry.sources.stage += 1;
    for (const stage of stageRows) entry.stages[stage.stage_id] = (entry.stages[stage.stage_id] ?? 0) + stage.n;
  }
  // The version a log line was written under: the newest attempt started before it (one read of the recent attempts, not one per line).
  const timeline = options.logLines?.length
    ? (db.prepare("SELECT created_at, harness_version FROM lane_pilot_attempt WHERE harness_version IS NOT NULL AND created_at<=? ORDER BY created_at DESC LIMIT 2000").all(options.until) as Array<{ created_at: number; harness_version: string }>).reverse()
    : [];
  const versionAt = (at: number): string => {
    let found = "";
    for (const row of timeline) { if (row.created_at > at) break; found = row.harness_version; }
    return found;
  };
  for (const line of options.logLines ?? []) {
    if (line.at < options.since || line.at >= options.until) continue;
    const sig = logSignature(line.message);
    const version = versionAt(line.at);
    const key = { classKey: sig.classKey, version, projectId: line.projectId || "-" };
    const entry = slot(key, () => ({ ...key, failureClass: "log", reasonNorm: sig.reasonNorm, origin: logOrigin(line.message) }), line.at);
    entry.n += 1;
    entry.sources.log += 1;
    if (entry.samples.length < 6) entry.samples.push(`log:${line.at}`);
  }
  return [...map.values()].map(({ taskSet, ...entry }) => ({ ...entry, tasks: Math.max(taskSet.size, entry.sources.log ? 1 : 0) }))
    .sort((a, b) => b.n - a.n || a.classKey.localeCompare(b.classKey));
}

/** The journal is idempotent per night: a second run of the same night replaces its rows. */
export function writeEntries(db: WallDb, entries: readonly Entry[], now: number): void {
  const put = db.prepare(`INSERT INTO lane_pilot_wall_entry (night,class_key,failure_class,reason_norm,origin,lp_version,project_id,n,tasks,sources_json,gates_json,stages_json,samples_json,first_at,last_at,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(night,class_key,lp_version,project_id) DO UPDATE SET failure_class=excluded.failure_class, reason_norm=excluded.reason_norm, origin=excluded.origin,
      n=excluded.n, tasks=excluded.tasks, sources_json=excluded.sources_json, gates_json=excluded.gates_json, stages_json=excluded.stages_json,
      samples_json=excluded.samples_json, first_at=excluded.first_at, last_at=excluded.last_at, recorded_at=excluded.recorded_at`);
  db.transaction(() => {
    for (const e of entries) put.run(e.night, e.classKey, e.failureClass, e.reasonNorm, e.origin, e.version, e.projectId, e.n, e.tasks,
      JSON.stringify(e.sources), JSON.stringify(e.gates), JSON.stringify(e.stages), JSON.stringify(e.samples), e.firstAt, e.lastAt, now);
  })();
}

/** The rung a class has reached: 3/10, then 5/100, then 6/500 (Maslov). Counts are failures among the last 10 / 100 / 500 finished attempts. */
export function rungOf(counts: readonly [number, number, number]): 0 | 1 | 2 | 3 {
  let rung = 0;
  for (let i = 0; i < RUNGS.length; i++) {
    if (counts[i]! > RUNGS[i]!.max) break;
    rung = i + 1;
  }
  return rung as 0 | 1 | 2 | 3;
}

type AttemptRow = { id: string; run_id: string; task_id: string; state: string; reason: string | null; updated_at: number; project_id: string; triage_origin: string | null };

/**
 * Recomputes the recurrence of every class seen in the last `lookbackDays`: failures among the last 10 / 100 / 500 finished real attempts,
 * the 7-day and 24-hour counts, the rung, open or closed. The wall ladder columns are kept as they are.
 */
export function refreshClasses(db: WallDb, options: { now: number; isReal: JournalOptions["isReal"]; lookbackDays?: number }): WallClass[] {
  const { now } = options;
  const since = now - (options.lookbackDays ?? 30) * DAY;
  const finished = db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.updated_at, r.project_id, t.origin AS triage_origin
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    LEFT JOIN lane_pilot_failure_triage t ON t.attempt_id=a.id AND t.project_id=r.project_id AND t.status='ok'
    WHERE a.updated_at<=? AND a.state NOT IN (${quoted([...IN_FLIGHT, "canceled"])})
    ORDER BY a.updated_at DESC LIMIT 4000`).all(now) as AttemptRow[];
  const real: Array<AttemptRow & { classKey: string | null; failureClass: string; reasonNorm: string; origin: string }> = [];
  for (const row of finished) {
    if (real.length >= RUNGS[2].window && row.updated_at < since) break;
    if (!options.isReal(row.project_id, row.task_id)) continue;
    if (real.length >= 2000) break;
    const failed = (FAILED_STATES as readonly string[]).includes(row.state);
    const sig = failed ? wallSignature(row.state, row.reason) : null;
    real.push({ ...row, classKey: sig?.classKey ?? null, failureClass: sig?.failureClass ?? "", reasonNorm: sig?.reasonNorm ?? "",
      origin: sig ? originOf(sig.failureClass, row.triage_origin) : "" });
  }
  const windows: [number, number, number] = [Math.min(RUNGS[0].window, real.length), Math.min(RUNGS[1].window, real.length), Math.min(RUNGS[2].window, real.length)];
  const byKey = new Map<string, { failureClass: string; reasonNorm: string; origins: Map<string, number>; counts: [number, number, number]; first: number; last: number; total: number; r7: number; r1: number }>();
  real.forEach((row, index) => {
    if (!row.classKey) return;
    let item = byKey.get(row.classKey);
    if (!item) {
      item = { failureClass: row.failureClass, reasonNorm: row.reasonNorm, origins: new Map(), counts: [0, 0, 0], first: row.updated_at, last: row.updated_at, total: 0, r7: 0, r1: 0 };
      byKey.set(row.classKey, item);
    }
    item.origins.set(row.origin, (item.origins.get(row.origin) ?? 0) + 1);
    RUNGS.forEach((rung, i) => { if (index < rung.window) item!.counts[i]! += 1; });
    item.first = Math.min(item.first, row.updated_at);
    item.last = Math.max(item.last, row.updated_at);
    item.total += 1;
    if (row.updated_at >= now - 7 * DAY) item.r7 += 1;
    if (row.updated_at >= now - DAY) item.r1 += 1;
  });
  const upsert = db.prepare(`INSERT INTO lane_pilot_wall_class (class_key,failure_class,reason_norm,origin,first_seen,last_seen,total,c10,c100,c500,w10,w100,w500,rung,state,recur7,recur1,closed_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(class_key) DO UPDATE SET failure_class=excluded.failure_class, reason_norm=excluded.reason_norm, origin=excluded.origin,
      first_seen=min(first_seen, excluded.first_seen), last_seen=excluded.last_seen, total=excluded.total, c10=excluded.c10, c100=excluded.c100, c500=excluded.c500,
      w10=excluded.w10, w100=excluded.w100, w500=excluded.w500, rung=excluded.rung, state=excluded.state, recur7=excluded.recur7, recur1=excluded.recur1,
      closed_at=CASE WHEN excluded.state='closed' AND lane_pilot_wall_class.state='open' THEN excluded.updated_at WHEN excluded.state='open' THEN NULL ELSE lane_pilot_wall_class.closed_at END,
      updated_at=excluded.updated_at`);
  db.transaction(() => {
    for (const [classKey, item] of byKey) {
      // Lane Pilot's side wins when any attempt of the class shows it (a triage said orchestrator, or the class is harness / infra); else the commonest origin.
      const origin = ["orchestrator", "harness", "infra"].find((side) => item.origins.has(side)) ?? [...item.origins.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      const rung = rungOf(item.counts);
      upsert.run(classKey, item.failureClass, item.reasonNorm, origin, item.first, item.last, item.total, item.counts[0], item.counts[1], item.counts[2],
        windows[0], windows[1], windows[2], rung, rung === 3 ? "closed" : "open", item.r7, item.r1, rung === 3 ? now : null, now);
    }
    // The plugin log's classes have no attempts: they recur when they were seen on two nights of the last seven and three times in all.
    const logs = db.prepare(`SELECT class_key, reason_norm, origin, min(first_at) AS first_at, max(last_at) AS last_at, sum(n) AS total,
        sum(CASE WHEN last_at>=? THEN n ELSE 0 END) AS r7, sum(CASE WHEN last_at>=? THEN n ELSE 0 END) AS r1,
        count(DISTINCT CASE WHEN last_at>=? THEN night END) AS nights
      FROM lane_pilot_wall_entry WHERE failure_class='log' AND last_at>=? AND last_at<=? GROUP BY class_key`)
      .all(now - 7 * DAY, now - DAY, now - 7 * DAY, since, now) as Array<{ class_key: string; reason_norm: string; origin: string; first_at: number; last_at: number; total: number; r7: number; r1: number; nights: number }>;
    const seen = [...byKey.keys()];
    for (const row of logs) {
      const recurring = row.nights >= 2 && row.r7 >= 3;
      upsert.run(row.class_key, "log", row.reason_norm, row.origin, row.first_at, row.last_at, row.total, 0, 0, 0, 0, 0, 0, recurring ? 0 : 3, recurring ? "open" : "closed", row.r7, row.r1, recurring ? null : now, now);
      seen.push(row.class_key);
    }
    // A class not seen in the window any more has nothing among the last attempts: it is within every bar.
    db.prepare(`UPDATE lane_pilot_wall_class SET c10=0,c100=0,c500=0,rung=3,state='closed',recur7=0,recur1=0,closed_at=COALESCE(closed_at,?),updated_at=?
      WHERE class_key NOT IN (${seen.map(() => "?").join(",") || "''"}) AND state='open'`).run(now, now, ...seen);
  })();
  return listClasses(db);
}

type ClassRow = {
  class_key: string; failure_class: string; reason_norm: string; origin: string; first_seen: number; last_seen: number; total: number;
  c10: number; c100: number; c500: number; w10: number; w100: number; w500: number; rung: number; state: "open" | "closed"; recur7: number; recur1: number;
  failed_moves: number; hunt_state: WallClass["hunt"]; after_hunt_failed: number; stage: WallClass["stage"];
};

export const classFrom = (row: ClassRow): WallClass => ({
  classKey: row.class_key, failureClass: row.failure_class, reasonNorm: row.reason_norm, origin: row.origin, firstSeen: row.first_seen, lastSeen: row.last_seen, total: row.total,
  counts: [row.c10, row.c100, row.c500], windows: [row.w10, row.w100, row.w500], rung: row.rung as WallClass["rung"], state: row.state, recur7: row.recur7, recur1: row.recur1,
  failedMoves: row.failed_moves, hunt: row.hunt_state, afterHuntFailed: row.after_hunt_failed, stage: row.stage,
});

export function listClasses(db: WallDb, filter: { state?: "open" | "closed" } = {}): WallClass[] {
  const rows = db.prepare(`SELECT * FROM lane_pilot_wall_class ${filter.state ? "WHERE state=?" : ""} ORDER BY recur1 DESC, recur7 DESC, last_seen DESC`)
    .all(...(filter.state ? [filter.state] : [])) as ClassRow[];
  return rows.map(classFrom);
}

export function getClass(db: WallDb, classKey: string): WallClass | null {
  const row = db.prepare("SELECT * FROM lane_pilot_wall_class WHERE class_key=?").get(classKey) as ClassRow | undefined;
  return row ? classFrom(row) : null;
}

/** The Lane Pilot versions each class was seen under since `since` (from the journal's entries); "" is a failure whose version is not known. */
export function classVersions(db: WallDb, since: number): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const row of db.prepare("SELECT class_key, lp_version FROM lane_pilot_wall_entry WHERE last_at>=? GROUP BY class_key, lp_version").all(since) as Array<{ class_key: string; lp_version: string }>) {
    const set = map.get(row.class_key) ?? new Set<string>();
    set.add(row.lp_version);
    map.set(row.class_key, set);
  }
  return map;
}
