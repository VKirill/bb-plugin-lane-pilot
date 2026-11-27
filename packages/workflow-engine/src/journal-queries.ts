import type Database from "better-sqlite3";
import { TERMINAL_RUN, type RunRow } from "./journal";

type WfReadDb = Pick<Database.Database, "prepare">;

/** Sums step-level `cost_micro_usd` per run id (null-safe) and flags runs with at least one step row. */
export function listStepCostsByRunIds(
  db: WfReadDb,
  runIds: readonly string[],
): Map<string, { hasSteps: boolean; costMicroUsd: number }> {
  const unique = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, { hasSteps: boolean; costMicroUsd: number }>();
  if (!unique.length) return out;
  const cols = new Set((db.prepare("PRAGMA table_info(lane_pilot_wf_step)").all() as Array<{ name: string }>).map((c) => c.name));
  const costExpr = cols.has("cost_micro_usd") ? "COALESCE(SUM(COALESCE(cost_micro_usd, 0)), 0)" : "0";
  for (let at = 0; at < unique.length; at += 400) {
    const chunk = unique.slice(at, at + 400);
    const rows = db.prepare(
      `SELECT run_id, COUNT(*) AS step_count, ${costExpr} AS cost_micro_usd
       FROM lane_pilot_wf_step
       WHERE run_id IN (${chunk.map(() => "?").join(",")})
       GROUP BY run_id`,
    ).all(...chunk) as Array<{ run_id: string; step_count: number; cost_micro_usd: number | null }>;
    for (const row of rows) {
      out.set(row.run_id, {
        hasSteps: Number(row.step_count) > 0,
        costMicroUsd: Number(row.cost_micro_usd ?? 0),
      });
    }
  }
  return out;
}

/** Finds run ids for a workflow matching any of the given thread/session ids across steps or inputs. */
export function listRunIdsByWorkflowAndThreads(
  db: WfReadDb,
  workflowId: string,
  threadIds: readonly string[],
): string[] {
  const unique = [...new Set(threadIds.map((id) => id.trim()).filter(Boolean))];
  if (!workflowId || !unique.length) return [];
  const stepCols = new Set((db.prepare("PRAGMA table_info(lane_pilot_wf_step)").all() as Array<{ name: string }>).map((c) => c.name));
  const hasSession = stepCols.has("session_id");
  const found = new Set<string>();
  for (let at = 0; at < unique.length; at += 200) {
    const chunk = unique.slice(at, at + 200);
    const ph = chunk.map(() => "?").join(",");
    const clauses = [
      `json_extract(r.inputs_json, '$.threadId') IN (${ph})`,
      `json_extract(r.inputs_json, '$.pmThreadId') IN (${ph})`,
    ];
    const params: unknown[] = [workflowId, ...chunk, ...chunk];
    if (hasSession) {
      clauses.push(`EXISTS (SELECT 1 FROM lane_pilot_wf_step s WHERE s.run_id = r.id AND s.session_id IN (${ph}))`);
      params.push(...chunk);
    }
    const rows = db.prepare(`SELECT r.id FROM lane_pilot_wf_run r WHERE r.workflow_id = ? AND (${clauses.join(" OR ")})`).all(...params) as Array<{ id: string }>;
    for (const row of rows) found.add(row.id);
  }
  return [...found];
}

/** Returns node IDs that executed at least one journaled `runEffect` call in the given runs. */
export function wfNodesWithEffects(db: WfReadDb, runIds: readonly string[]): Set<string> {
  const unique = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Set<string>();
  if (!unique.length) return out;
  for (let at = 0; at < unique.length; at += 400) {
    const chunk = unique.slice(at, at + 400);
    const ph = chunk.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT DISTINCT s.node_id
       FROM lane_pilot_wf_effect e
       JOIN lane_pilot_wf_step s ON s.run_id = e.run_id AND s.step_key = e.step_key
       WHERE e.run_id IN (${ph})`,
    ).all(...chunk) as Array<{ node_id: string }>;
    for (const row of rows) out.add(row.node_id);
  }
  return out;
}

export type WfChildRunStageRow = {
  id: string;
  parent_step_key: string;
  workflow_id: string;
  workflow_version: number;
  status: string;
  inputs_json: string;
  created_at: number;
};

/** Child runs of `runId` in start order with version and inputs for template extraction. */
export function wfChildRunStages(db: WfReadDb, runId: string): WfChildRunStageRow[] {
  return db.prepare(
    "SELECT id, parent_step_key, workflow_id, workflow_version, status, inputs_json, created_at FROM lane_pilot_wf_run WHERE parent_run_id = ? ORDER BY created_at ASC, rowid ASC",
  ).all(runId) as WfChildRunStageRow[];
}

export type WfGoalAuditEvent = {
  verdict: string;
  met: string[];
  unmet: Array<{ id: string; why: string }>;
  at: number;
};

/** Latest `goal_audit` journal event recorded on `runId`, or `null` when unaudited. */
export function wfLastGoalAudit(db: WfReadDb, runId: string): WfGoalAuditEvent | null {
  const row = db.prepare(
    "SELECT to_state, detail, at FROM lane_pilot_wf_event WHERE run_id = ? AND kind = 'goal_audit' ORDER BY seq DESC LIMIT 1",
  ).get(runId) as { to_state: string | null; detail: string | null; at: number } | undefined;
  if (!row) return null;
  if (!row.detail) {
    return row.to_state ? { verdict: row.to_state, met: [], unmet: [], at: row.at } : null;
  }
  try {
    const detail = JSON.parse(row.detail) as Record<string, unknown>;
    return {
      verdict: typeof detail.verdict === "string" ? detail.verdict : String(row.to_state ?? ""),
      met: Array.isArray(detail.met) ? detail.met.filter((item): item is string => typeof item === "string") : [],
      unmet: Array.isArray(detail.unmet) ? (detail.unmet as Array<{ id: string; why: string }>) : [],
      at: row.at,
    };
  } catch {
    return row.to_state ? { verdict: row.to_state, met: [], unmet: [], at: row.at } : null;
  }
}

export type TrialRunRow = Pick<
  RunRow,
  "id" | "workflow_id" | "workflow_version" | "status" | "output_json" | "definition_json" | "cost_micro_usd" | "created_at" | "updated_at" | "arm" | "trial_id"
>;

/** Finished top-level runs belonging to a canary trial, ordered by arrival (`created_at ASC, rowid ASC`). */
export function wfTrialRuns(db: WfReadDb, trialId: string): TrialRunRow[] {
  const placeholders = TERMINAL_RUN.map(() => "?").join(", ");
  return db.prepare(
    `SELECT id, workflow_id, workflow_version, status, output_json, definition_json, cost_micro_usd, created_at, updated_at, arm, trial_id
     FROM lane_pilot_wf_run
     WHERE trial_id = ? AND parent_run_id IS NULL AND arm IN ('old', 'new') AND status IN (${placeholders})
     ORDER BY created_at ASC, rowid ASC`,
  ).all(trialId, ...TERMINAL_RUN) as TrialRunRow[];
}

/** Counts workflow runs created within `[since, until]` inclusive for post-publication health checks. */
export function wfCountRunsInWindow(
  db: WfReadDb,
  workflowId: string,
  since: number,
  until: number,
): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lane_pilot_wf_run'").get();
  if (!table) return 0;
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM lane_pilot_wf_run
     WHERE workflow_id = ? AND created_at >= ? AND created_at <= ?`,
  ).get(workflowId, since, until) as { cnt?: unknown } | undefined;
  return Number(row?.cnt ?? 0);
}
