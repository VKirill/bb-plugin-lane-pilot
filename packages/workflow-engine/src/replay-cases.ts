import type Database from "better-sqlite3";

import { TERMINAL_RUN, type RunStatus } from "./journal";
import type { Workflow } from "./schema";

type ReadDb = Pick<Database.Database, "prepare">;

export type ReplayCase = {
  runId: string;
  graphVersion: number;
  inputs: Record<string, unknown>;
  humanAnswers: Record<string, unknown>;
  recorded: Record<string, unknown>;
  verdict: "accept" | "reject" | null;
  taskClass: string | null;
};

export type ReplayCaseSkip = {
  runId: string;
  reason: string;
};

export type ReplayCasesResult = {
  cases: ReplayCase[];
  skipped: ReplayCaseSkip[];
};

export type ReplayCasesOptions = {
  limit?: number;
  since?: number;
  runIds?: readonly string[];
  /** When true, explicit `runIds` from a captured source run (e.g. an errand) are kept across workflow IDs/node shapes. */
  allowCrossWorkflow?: boolean;
  /** Current graph definition whose node ids determine whether a past run still applies. */
  workflow?: Pick<Workflow, "nodes">;
  currentNodeIds?: readonly string[] | ReadonlySet<string>;
  log?: ((message: string) => void) | { debug?: (message: string) => void };
};

const RUN_VERDICT_TABLE = "lane_pilot_wf_run_verdict";
const TERMINAL_SET = new Set<string>(TERMINAL_RUN);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJsonValue(raw: string | null | undefined): unknown {
  if (!raw || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function parseRecord(raw: string | null | undefined): Record<string, unknown> {
  const parsed = parseJsonValue(raw);
  return isRecord(parsed) ? parsed : {};
}

function nodeSetsFromDefinition(defJson: string): { ids: Set<string>; humanIds: Set<string> } {
  const ids = new Set<string>();
  const humanIds = new Set<string>();
  const parsed = parseJsonValue(defJson);
  if (!isRecord(parsed) || !Array.isArray(parsed.nodes)) return { ids, humanIds };
  for (const node of parsed.nodes) {
    if (!isRecord(node)) continue;
    if (typeof node.id === "string" && node.id) {
      if (node.type !== "note") ids.add(node.id);
      if (node.type === "human") humanIds.add(node.id);
    }
  }
  return { ids, humanIds };
}

function isHumanAwait(awaitJson: string | null | undefined): boolean {
  const parsed = parseJsonValue(awaitJson);
  return isRecord(parsed) && parsed.kind === "human";
}

function tableExists(db: ReadDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function emitDebug(log: ReplayCasesOptions["log"], message: string): void {
  if (!log) return;
  if (typeof log === "function") log(`DEBUG ${message}`);
  else log.debug?.(message);
}

type RawRunRow = {
  id: string;
  workflow_id: string;
  workflow_version: number;
  definition_json: string;
  parent_run_id: string | null;
  status: RunStatus;
  inputs_json: string;
  created_at: number;
};

type RawStepRow = {
  run_id: string;
  node_id: string;
  output_json: string | null;
  await_json: string | null;
};

/**
 * Extracts replayable test cases from top-level finished runs in the workflow journal.
 * Runs whose definition has no node ids in common with the current graph are skipped.
 */
export function replayCasesFromRuns(
  db: ReadDb,
  workflowId: string,
  options: ReplayCasesOptions = {},
): ReplayCasesResult {
  const limit = options.limit === undefined ? 50 : Math.floor(options.limit);
  if (limit <= 0) {
    emitDebug(options.log, `replay cases graph=${workflowId} n=0 skipped=0`);
    return { cases: [], skipped: [] };
  }
  const cappedLimit = Math.min(limit, 500);
  const skipped: ReplayCaseSkip[] = [];

  let rows: RawRunRow[] = [];
  if (options.runIds !== undefined) {
    const uniqueIds = [...new Set(options.runIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
      emitDebug(options.log, `replay cases graph=${workflowId} n=0 skipped=0`);
      return { cases: [], skipped: [] };
    }
    const byId = new Map<string, RawRunRow>();
    for (let at = 0; at < uniqueIds.length; at += 400) {
      const chunk = uniqueIds.slice(at, at + 400);
      const found = db.prepare(
        `SELECT id, workflow_id, workflow_version, definition_json, parent_run_id, status, inputs_json, created_at
         FROM lane_pilot_wf_run
         WHERE id IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk) as RawRunRow[];
      for (const row of found) byId.set(row.id, row);
    }
    for (const id of uniqueIds) {
      const row = byId.get(id);
      if (!row) skipped.push({ runId: id, reason: "not_found" });
      else rows.push(row);
    }
    rows.sort((a, b) => b.created_at - a.created_at);
  } else {
    const clauses = [
      "workflow_id = ?",
      "parent_run_id IS NULL",
      `status IN (${TERMINAL_RUN.map(() => "?").join(",")})`,
    ];
    const params: unknown[] = [workflowId, ...TERMINAL_RUN];
    if (options.since !== undefined) {
      clauses.push("created_at >= ?");
      params.push(options.since);
    }
    params.push(cappedLimit);
    rows = db.prepare(
      `SELECT id, workflow_id, workflow_version, definition_json, parent_run_id, status, inputs_json, created_at
       FROM lane_pilot_wf_run
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    ).all(...params) as RawRunRow[];
  }

  let currentNodeIds: Set<string> | null = null;
  const currentHumanIds = new Set<string>();
  if (options.currentNodeIds) {
    currentNodeIds = new Set(options.currentNodeIds);
  } else if (options.workflow) {
    currentNodeIds = new Set();
    for (const node of options.workflow.nodes) {
      if (node.type !== "note") currentNodeIds.add(node.id);
      if (node.type === "human") currentHumanIds.add(node.id);
    }
  } else {
    for (const row of rows) {
      if (row.workflow_id !== workflowId || row.parent_run_id !== null || !TERMINAL_SET.has(row.status)) continue;
      const latest = nodeSetsFromDefinition(row.definition_json);
      if (latest.ids.size > 0) {
        currentNodeIds = latest.ids;
        break;
      }
    }
  }

  const eligible: Array<{ row: RawRunRow; humanIds: Set<string> }> = [];
  for (const row of rows) {
    if (row.parent_run_id !== null) {
      skipped.push({ runId: row.id, reason: "child_run" });
      continue;
    }
    if (!TERMINAL_SET.has(row.status)) {
      skipped.push({ runId: row.id, reason: "not_finished" });
      continue;
    }
    if (options.since !== undefined && row.created_at < options.since) {
      skipped.push({ runId: row.id, reason: "before_since" });
      continue;
    }
    if (row.workflow_id !== workflowId && !options.allowCrossWorkflow) {
      skipped.push({ runId: row.id, reason: "workflow_mismatch" });
      continue;
    }
    const def = nodeSetsFromDefinition(row.definition_json);
    if (!options.allowCrossWorkflow && currentNodeIds && currentNodeIds.size > 0) {
      let hasCommon = false;
      for (const id of def.ids) {
        if (currentNodeIds.has(id)) {
          hasCommon = true;
          break;
        }
      }
      if (!hasCommon) {
        skipped.push({ runId: row.id, reason: "no_common_nodes" });
        continue;
      }
    }
    if (eligible.length < cappedLimit) {
      eligible.push({ row, humanIds: def.humanIds });
    }
  }

  if (eligible.length === 0) {
    emitDebug(options.log, `replay cases graph=${workflowId} n=0 skipped=${skipped.length}`);
    return { cases: [], skipped };
  }

  const eligibleIds = eligible.map((item) => item.row.id);
  const stepsByRun = new Map<string, RawStepRow[]>();
  for (let at = 0; at < eligibleIds.length; at += 400) {
    const chunk = eligibleIds.slice(at, at + 400);
    const stepRows = db.prepare(
      `SELECT run_id, node_id, output_json, await_json
       FROM lane_pilot_wf_step
       WHERE run_id IN (${chunk.map(() => "?").join(",")}) AND state = 'succeeded'
       ORDER BY COALESCE(started_at, updated_at) ASC, rowid ASC`,
    ).all(...chunk) as RawStepRow[];
    for (const step of stepRows) {
      const list = stepsByRun.get(step.run_id);
      if (list) list.push(step);
      else stepsByRun.set(step.run_id, [step]);
    }
  }

  const verdicts = new Map<string, "accept" | "reject">();
  if (tableExists(db, RUN_VERDICT_TABLE)) {
    for (let at = 0; at < eligibleIds.length; at += 400) {
      const chunk = eligibleIds.slice(at, at + 400);
      const verdictRows = db.prepare(
        `SELECT run_id, verdict
         FROM ${RUN_VERDICT_TABLE}
         WHERE run_id IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk) as Array<{ run_id: string; verdict: string }>;
      for (const v of verdictRows) {
        if (v.verdict === "accept" || v.verdict === "reject") {
          verdicts.set(v.run_id, v.verdict);
        }
      }
    }
  }

  const cases: ReplayCase[] = eligible.map(({ row, humanIds }) => {
    const inputs = parseRecord(row.inputs_json);
    const recorded: Record<string, unknown> = {};
    const humanAnswers: Record<string, unknown> = {};
    for (const step of stepsByRun.get(row.id) ?? []) {
      const parsedOut = parseJsonValue(step.output_json);
      if (parsedOut === undefined || parsedOut === null) continue;
      recorded[step.node_id] = parsedOut;
      if (humanIds.has(step.node_id) || currentHumanIds.has(step.node_id) || isHumanAwait(step.await_json)) {
        humanAnswers[step.node_id] = parsedOut;
      }
    }
    const rawTaskClass = inputs.task_class ?? inputs.process_key ?? null;
    const taskClass = typeof rawTaskClass === "string" && rawTaskClass.trim() ? rawTaskClass : null;
    return {
      runId: row.id,
      graphVersion: Number(row.workflow_version),
      inputs,
      humanAnswers,
      recorded,
      verdict: verdicts.get(row.id) ?? null,
      taskClass,
    };
  });

  emitDebug(options.log, `replay cases graph=${workflowId} n=${cases.length} skipped=${skipped.length}`);
  return { cases, skipped };
}
