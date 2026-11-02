import { sha256Hex } from "@lane-pilot/kit";
import type { Db } from "../learning/store";

/** One replay scenario: the moment before the PM's wrong action, plus the rubric a judge grades a replay against. */
export type Scenario = {
  id: string; projectId: string; sourceThread: string | null; sourceSeq: number | null;
  msg: string; responses: Record<string, unknown>;
  expect: string[]; forbid: string[]; argCheck: Record<string, string>;
  should: string | null; failIf: string | null; ruleId: string | null;
  createdAt: number; state: "active" | "retired";
};

type Row = Record<string, unknown>;
const parse = <T>(value: unknown, dflt: T): T => { try { return value ? JSON.parse(value as string) as T : dflt; } catch { return dflt; } };

const fromRow = (row: Row): Scenario => ({
  id: row.id as string, projectId: row.project_id as string,
  sourceThread: (row.source_thread as string | null) ?? null, sourceSeq: (row.source_seq as number | null) ?? null,
  msg: row.msg as string, responses: parse(row.responses_json, {}),
  expect: parse(row.expect_json, []), forbid: parse(row.forbid_json, []), argCheck: parse(row.arg_check_json, {}),
  should: (row.should as string | null) ?? null, failIf: (row.fail_if as string | null) ?? null,
  ruleId: (row.rule_id as string | null) ?? null,
  createdAt: row.created_at as number, state: row.state as Scenario["state"],
});

export const scenarioId = (msg: string): string => `pmsc_${sha256Hex(msg).slice(0, 12)}`;

export function insertScenario(db: Db, s: Scenario): boolean {
  return db.prepare(`INSERT OR IGNORE INTO lane_pilot_pm_scenario
    (id, project_id, source_thread, source_seq, msg, responses_json, expect_json, forbid_json, arg_check_json, should, fail_if, rule_id, created_at, state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(s.id, s.projectId, s.sourceThread, s.sourceSeq, s.msg, JSON.stringify(s.responses), JSON.stringify(s.expect),
      JSON.stringify(s.forbid), JSON.stringify(s.argCheck), s.should, s.failIf, s.ruleId, s.createdAt, s.state).changes === 1;
}

export function getScenario(db: Db, id: string): Scenario | null {
  const row = db.prepare("SELECT * FROM lane_pilot_pm_scenario WHERE id=?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listScenarios(db: Db, filter: { state?: "active" | "retired"; ruleId?: string; limit?: number } = {}): Scenario[] {
  const where = [filter.state ? "state=?" : "1=1", filter.ruleId ? "rule_id=?" : "1=1"].join(" AND ");
  const args = [filter.state, filter.ruleId].filter((v) => v !== undefined);
  return (db.prepare(`SELECT * FROM lane_pilot_pm_scenario WHERE ${where} ORDER BY created_at LIMIT ?`).all(...args, filter.limit ?? 1000) as Row[]).map(fromRow);
}

export function retireScenario(db: Db, id: string): boolean {
  return db.prepare("UPDATE lane_pilot_pm_scenario SET state='retired' WHERE id=? AND state='active'").run(id).changes === 1;
}

/** Tie scenarios to the rule that should fix them (the harvest writes the link when the correction became a rule). */
export function linkScenariosToRule(db: Db, ids: readonly string[], ruleId: string): number {
  const update = db.prepare("UPDATE lane_pilot_pm_scenario SET rule_id=? WHERE id=?");
  let n = 0;
  for (const id of ids) n += update.run(ruleId, id).changes;
  return n;
}

/* ---- replay results ---- */

export type ReplayResult = {
  id: number; scenarioId: string; arm: string; sample: number;
  verdict: string; why: string | null; calls: Array<{ tool: string; args: unknown }>; costUsd: number; at: number;
};

const resultFrom = (row: Row): ReplayResult => ({
  id: row.id as number, scenarioId: row.scenario_id as string, arm: row.arm as string, sample: row.sample as number,
  verdict: row.verdict as string, why: (row.why as string | null) ?? null,
  calls: parse(row.calls_json, []), costUsd: row.cost_usd as number, at: row.at as number,
});

export function insertResult(db: Db, r: Omit<ReplayResult, "id">): void {
  db.prepare(`INSERT INTO lane_pilot_pm_replay (scenario_id, arm, sample, verdict, why, calls_json, cost_usd, at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(r.scenarioId, r.arm, r.sample, r.verdict, r.why, JSON.stringify(r.calls), r.costUsd, r.at);
}

/** The newest verdict of each scenario on one arm (or of each arm for one scenario). */
export function latestVerdicts(db: Db, filter: { arm?: string; scenarioId?: string; since?: number } = {}): Map<string, { verdict: string; why: string | null; at: number; sample: number }> {
  const key = filter.scenarioId ? "arm" : "scenario_id";
  const rows = db.prepare(`SELECT ${key} AS k, verdict, why, at, sample FROM lane_pilot_pm_replay
    WHERE ${filter.arm ? "arm=?" : "1=1"} AND ${filter.scenarioId ? "scenario_id=?" : "1=1"} AND ${filter.since ? "at>=?" : "1=1"}
    ORDER BY at DESC`).all(...[filter.arm, filter.scenarioId, filter.since].filter((v) => v !== undefined)) as Row[];
  const out = new Map<string, { verdict: string; why: string | null; at: number; sample: number }>();
  for (const row of rows) {
    const k = row.k as string;
    if (!out.has(k)) out.set(k, { verdict: row.verdict as string, why: (row.why as string | null) ?? null, at: row.at as number, sample: row.sample as number });
  }
  return out;
}

/** Spend of one night (or a run), for the budget guard and `pm-replay status`. */
export function replayStats(db: Db, since: number): { runs: number; costUsd: number; pass: number; fail: number; other: number } {
  const row = db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd),0) AS cost,
    SUM(CASE WHEN verdict='PASS' THEN 1 ELSE 0 END) AS pass, SUM(CASE WHEN verdict='FAIL' THEN 1 ELSE 0 END) AS fail,
    SUM(CASE WHEN verdict NOT IN ('PASS','FAIL') THEN 1 ELSE 0 END) AS other
    FROM lane_pilot_pm_replay WHERE at>=?`).get(since) as { runs: number; cost: number; pass: number | null; fail: number | null; other: number | null };
  return { runs: row.runs, costUsd: row.cost, pass: row.pass ?? 0, fail: row.fail ?? 0, other: row.other ?? 0 };
}
