import type Database from "better-sqlite3";
import type { CostState, NodeCensusClass, NodeCensusEntry } from "@lane-pilot/contracts";

import { tallyOutcomes, type OutcomeRow } from "./business-outcome";
import type { RunRecord } from "./router";

export type WorkflowRunFactSummary = {
  runs: number;
  workDone: number;
  failed: number;
  lastRunAt: number | null;
  steps: number;
  passedSteps: number;
  failedSteps: number;
  reworkVisits: number;
  avgDurationMs: number;
  costUsd: number | null;
  costState: CostState;
};

export type WorkflowWindowStats = {
  runs: number;
  succeeded: number;
  failed: number;
  costUsd: number | null;
  costState: CostState;
  measuredSteps: number;
  notMeasuredSteps: number;
};

/** Returns true when `workflowId` already has a live run parked on a waiting step (optionally excluding `excludeRunId`). */
export function hasParkedWorkflowWait(
  db: Pick<Database.Database, "prepare">,
  workflowId: string,
  excludeRunId?: string,
): boolean {
  const row = excludeRunId
    ? db.prepare(`SELECT 1 FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id
        WHERE r.workflow_id=? AND r.id<>? AND r.status IN ('running','waiting') AND s.state='waiting' LIMIT 1`).get(workflowId, excludeRunId)
    : db.prepare(`SELECT 1 FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id
        WHERE r.workflow_id=? AND r.status IN ('running','waiting') AND s.state='waiting' LIMIT 1`).get(workflowId);
  return row !== undefined;
}

/** Summarize top-level workflow runs and Task 26 per-step cost facts since `sinceMs`. */
export function workflowWindowStats(
  db: Pick<Database.Database, "prepare">,
  sinceMs: number,
): WorkflowWindowStats {
  const runRows = db.prepare(`SELECT status FROM lane_pilot_wf_run
    WHERE parent_run_id IS NULL AND updated_at>=?`).all(sinceMs) as Array<{ status: string }>;
  let succeeded = 0;
  let failed = 0;
  for (const row of runRows) {
    if (row.status === "succeeded") succeeded += 1;
    else if (row.status === "failed" || row.status === "blocked" || row.status === "interrupted" || row.status === "not_verified") failed += 1;
  }
  const stepRows = db.prepare(`SELECT s.cost_micro_usd, s.cost_state FROM lane_pilot_wf_step s
    JOIN lane_pilot_wf_run r ON r.id=s.run_id
    WHERE r.parent_run_id IS NULL AND COALESCE(s.ended_at, s.updated_at)>=?
      AND s.state IN ('succeeded','failed','skipped','canceled')`).all(sinceMs) as Array<{
    cost_micro_usd: number | null;
    cost_state: string | null;
  }>;
  let measuredMicroUsd = 0;
  let measuredCount = 0;
  let partialCount = 0;
  let notMeasuredCount = 0;
  for (const row of stepRows) {
    if (row.cost_state === "measured") {
      measuredCount += 1;
      measuredMicroUsd += row.cost_micro_usd ?? 0;
    } else if (row.cost_state === "partial") {
      partialCount += 1;
      measuredMicroUsd += row.cost_micro_usd ?? 0;
    } else if (row.cost_state === "not_measured") {
      notMeasuredCount += 1;
    }
  }
  const costState: CostState = (measuredCount === 0 && partialCount === 0)
    ? "not_measured"
    : partialCount === 0 && notMeasuredCount === 0
      ? "measured"
      : measuredMicroUsd === 0 && notMeasuredCount > 0
        ? "not_measured"
        : "partial";
  return {
    runs: runRows.length,
    succeeded,
    failed,
    costUsd: costState === "not_measured" ? null : measuredMicroUsd / 1_000_000,
    costState,
    measuredSteps: measuredCount + partialCount,
    notMeasuredSteps: notMeasuredCount,
  };
}

/** Summarize Task 26 per-step run facts and outcomes by workflow id when runs exist. */
export function workflowRunFactSummaries(db: Database.Database): Map<string, WorkflowRunFactSummary> {
  const records = runRecords(db);
  const out = new Map<string, WorkflowRunFactSummary>();
  if (records.size === 0) return out;
  const rows = db.prepare(`SELECT r.workflow_id AS id, s.state, s.verdict, s.cost_micro_usd, s.cost_state, s.duration_ms, s.rework_visits, s.visit
    FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id
    WHERE r.parent_run_id IS NULL AND s.state IN ('succeeded','failed','skipped','canceled')`).all() as Array<{
    id: string;
    state: string;
    verdict: string | null;
    cost_micro_usd: number | null;
    cost_state: string | null;
    duration_ms: number | null;
    rework_visits: number | null;
    visit: number;
  }>;
  const stepStats = new Map<string, {
    steps: number;
    passedSteps: number;
    failedSteps: number;
    reworkVisits: number;
    durationMs: number;
    measuredMicroUsd: number;
    measuredCount: number;
    notMeasuredCount: number;
    partialCount: number;
  }>();
  for (const row of rows) {
    const bucket = stepStats.get(row.id) ?? {
      steps: 0, passedSteps: 0, failedSteps: 0, reworkVisits: 0, durationMs: 0,
      measuredMicroUsd: 0, measuredCount: 0, notMeasuredCount: 0, partialCount: 0,
    };
    bucket.steps += 1;
    const verdict = row.verdict ?? (row.state === "skipped" || row.state === "canceled" ? "not_run" : row.state === "failed" ? "fail" : "pass");
    if (verdict === "pass") bucket.passedSteps += 1;
    else if (verdict === "fail") bucket.failedSteps += 1;
    bucket.reworkVisits += row.rework_visits ?? Math.max(0, row.visit - 1);
    bucket.durationMs += row.duration_ms ?? 0;
    if (row.cost_state === "measured") {
      bucket.measuredCount += 1;
      bucket.measuredMicroUsd += row.cost_micro_usd ?? 0;
    } else if (row.cost_state === "partial") {
      bucket.partialCount += 1;
      bucket.measuredMicroUsd += row.cost_micro_usd ?? 0;
    } else if (row.cost_state === "not_measured") {
      bucket.notMeasuredCount += 1;
    }
    stepStats.set(row.id, bucket);
  }
  for (const [id, rec] of records) {
    const runs = rec.executed + rec.refused + rec.escalated + rec.failed;
    const st = stepStats.get(id);
    if (runs === 0 && !st) continue;
    const costState: CostState = !st || (st.measuredCount === 0 && st.partialCount === 0)
      ? "not_measured"
      : st.partialCount === 0 && st.notMeasuredCount === 0
        ? "measured"
        : st.measuredMicroUsd === 0 && st.notMeasuredCount > 0
          ? "not_measured"
          : "partial";
    const runCount = Math.max(1, runs);
    out.set(id, {
      runs: runs || 1,
      workDone: rec.workDone,
      failed: rec.failed,
      lastRunAt: rec.lastRunAt,
      steps: st?.steps ?? 0,
      passedSteps: st?.passedSteps ?? 0,
      failedSteps: st?.failedSteps ?? 0,
      reworkVisits: st?.reworkVisits ?? 0,
      avgDurationMs: st ? Math.round(st.durationMs / runCount) : 0,
      costUsd: costState === "not_measured" || !st ? null : st.measuredMicroUsd / 1_000_000,
      costState,
    });
  }
  return out;
}

/** How each workflow has run: finished top-level runs by business outcome and when the last one started. The router's tiebreaker reads it. */
export function runRecords(db: Database.Database): Map<string, RunRecord> {
  // ponytail: classifies every top-level run in JS. Ceiling: a long journal. Upgrade: a stored outcome column.
  const rows = db.prepare(`SELECT workflow_id AS id, status, output_json, definition_json, created_at
    FROM lane_pilot_wf_run WHERE parent_run_id IS NULL`).all() as Array<OutcomeRow & { id: string; created_at: number }>;
  const grouped = new Map<string, { rows: OutcomeRow[]; last: number | null }>();
  for (const row of rows) {
    const bucket = grouped.get(row.id) ?? { rows: [], last: null };
    bucket.rows.push(row);
    bucket.last = bucket.last === null ? row.created_at : Math.max(bucket.last, row.created_at);
    grouped.set(row.id, bucket);
  }
  const out = new Map<string, RunRecord>();
  for (const [id, bucket] of grouped) {
    const tally = tallyOutcomes(bucket.rows);
    out.set(id, {
      succeeded: tally.workDone,
      failed: tally.engineBad + tally.executed - tally.workDone - tally.escalated,
      lastRunAt: bucket.last,
      executed: tally.executed,
      workDone: tally.workDone,
      refused: tally.refused,
      escalated: tally.escalated,
    });
  }
  return out;
}

type CensusRawRow = {
  node_id: string;
  input_json: string;
  verdict: string | null;
  state: string;
  cost_micro_usd: number | null;
  rework_visits: number | null;
  visit: number;
  definition_json: string;
};

type ParsedNodeInfo = {
  type?: string;
  out?: unknown;
  output?: unknown;
  produces?: unknown[];
  gates?: unknown[];
};

function parseNodeMap(definitionJson: string): Map<string, ParsedNodeInfo> {
  try {
    const parsed = JSON.parse(definitionJson) as { nodes?: Array<{ id?: string } & ParsedNodeInfo> };
    const map = new Map<string, ParsedNodeInfo>();
    for (const node of parsed.nodes ?? []) {
      if (node.id) map.set(node.id, node);
    }
    return map;
  } catch {
    return new Map();
  }
}

function inputShapeSignature(inputJson: string): string {
  try {
    const parsed = JSON.parse(inputJson) as { with?: Record<string, unknown> };
    if (!parsed.with || typeof parsed.with !== "object") return "";
    return Object.keys(parsed.with).sort().join(",");
  } catch {
    return "";
  }
}

function hasBoundedOutput(node: ParsedNodeInfo | undefined): boolean {
  if (!node) return false;
  const schema = node.out ?? node.output;
  if (Array.isArray(schema)) return schema.length > 0;
  if (schema && typeof schema === "object") return Object.keys(schema as Record<string, unknown>).length > 0;
  return Boolean((node.produces && node.produces.length > 0) || (node.gates && node.gates.length > 0));
}

function classifyCensusNode(
  nodeKind: string,
  nodeInfo: ParsedNodeInfo | undefined,
  passed: number,
  failed: number,
  totalReworkVisits: number,
  inputShapes: Set<string>,
): NodeCensusClass {
  if (nodeKind !== "agent") return "code";
  const executed = passed + failed;
  if (executed === 0 || passed === 0) return "open_agent";
  const passRate = passed / executed;
  const reworkRate = totalReworkVisits / executed;
  if (passRate < 0.8 || reworkRate > 0.2) return "open_agent";
  if (hasBoundedOutput(nodeInfo) && inputShapes.size <= 1) return "stable_agent";
  return "open_agent";
}

/**
 * Node census for self-evolution (Task 26 / Task 20): classifies nodes as `code`, `stable_agent` (form-arm candidate),
 * or `open_agent` and computes each node's share of measured workflow cost using only step/run tables (no chat transcripts).
 */
export function nodeCensus(db: Database.Database, options: { workflowId?: string } = {}): NodeCensusEntry[] {
  const where = options.workflowId
    ? "s.state IN ('succeeded','failed','skipped','canceled') AND r.workflow_id=?"
    : "s.state IN ('succeeded','failed','skipped','canceled')";
  const rows = (options.workflowId
    ? db.prepare(`SELECT s.node_id, s.input_json, s.verdict, s.state, s.cost_micro_usd, s.rework_visits, s.visit, r.definition_json
        FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id WHERE ${where} ORDER BY s.rowid`).all(options.workflowId)
    : db.prepare(`SELECT s.node_id, s.input_json, s.verdict, s.state, s.cost_micro_usd, s.rework_visits, s.visit, r.definition_json
        FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id WHERE ${where} ORDER BY s.rowid`).all()) as CensusRawRow[];

  const parsedDefs = new Map<string, Map<string, ParsedNodeInfo>>();
  const grouped = new Map<string, {
    nodeKind: string;
    nodeInfo: ParsedNodeInfo | undefined;
    steps: number;
    passed: number;
    failed: number;
    notRun: number;
    totalReworkVisits: number;
    measuredCostMicroUsd: number;
    inputShapes: Set<string>;
  }>();
  let totalMeasuredCostMicroUsd = 0;

  for (const row of rows) {
    let nodes = parsedDefs.get(row.definition_json);
    if (!nodes) { nodes = parseNodeMap(row.definition_json); parsedDefs.set(row.definition_json, nodes); }
    const nodeInfo = nodes.get(row.node_id);
    const bucket = grouped.get(row.node_id) ?? {
      nodeKind: nodeInfo?.type ?? "unknown",
      nodeInfo,
      steps: 0,
      passed: 0,
      failed: 0,
      notRun: 0,
      totalReworkVisits: 0,
      measuredCostMicroUsd: 0,
      inputShapes: new Set<string>(),
    };
    if (nodeInfo) { bucket.nodeInfo = nodeInfo; bucket.nodeKind = nodeInfo.type ?? bucket.nodeKind; }
    bucket.steps += 1;
    const verdict = row.verdict ?? (row.state === "skipped" || row.state === "canceled" ? "not_run" : row.state === "failed" ? "fail" : "pass");
    if (verdict === "pass") bucket.passed += 1;
    else if (verdict === "fail") bucket.failed += 1;
    else bucket.notRun += 1;
    bucket.totalReworkVisits += row.rework_visits ?? Math.max(0, row.visit - 1);
    if (row.cost_micro_usd !== null && row.cost_micro_usd !== undefined) {
      bucket.measuredCostMicroUsd += row.cost_micro_usd;
      totalMeasuredCostMicroUsd += row.cost_micro_usd;
    }
    bucket.inputShapes.add(inputShapeSignature(row.input_json));
    grouped.set(row.node_id, bucket);
  }

  return [...grouped.entries()].map(([nodeId, bucket]) => {
    const classification = classifyCensusNode(
      bucket.nodeKind,
      bucket.nodeInfo,
      bucket.passed,
      bucket.failed,
      bucket.totalReworkVisits,
      bucket.inputShapes,
    );
    const costShare = totalMeasuredCostMicroUsd > 0 ? bucket.measuredCostMicroUsd / totalMeasuredCostMicroUsd : 0;
    return {
      nodeId,
      nodeKind: bucket.nodeKind,
      classification,
      steps: bucket.steps,
      passed: bucket.passed,
      failed: bucket.failed,
      notRun: bucket.notRun,
      totalReworkVisits: bucket.totalReworkVisits,
      measuredCostMicroUsd: bucket.measuredCostMicroUsd,
      costShare,
      formArmCandidate: classification === "stable_agent" && costShare > 0,
    };
  }).sort((a, b) => b.costShare - a.costShare || b.steps - a.steps || a.nodeId.localeCompare(b.nodeId));
}
