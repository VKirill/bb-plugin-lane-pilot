import {
  EVOLVE_THRESHOLDS,
  isRunVerdict,
  type CaseSplit,
  type RunVerdict,
} from "@lane-pilot/contracts";
import { sha256Hex } from "@lane-pilot/kit";

type CaseStmt = {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

export type EvolveCaseDb = {
  prepare(sql: string): CaseStmt;
  transaction<T>(fn: () => T): () => T;
};

export type EvolveLogSink = {
  debug?: ((message: string) => void) | undefined;
  info?: ((message: string) => void) | undefined;
  warn?: ((message: string) => void) | undefined;
  error?: ((message: string) => void) | undefined;
};

export type EvolveCaseRow = {
  caseId: string;
  workflowId: string;
  runId: string;
  split: CaseSplit;
  taskClass: string | null;
  verdict: RunVerdict;
  graphVersion: number;
  addedAt: number;
  rotatedAt: number | null;
};

export type AddCaseInput = {
  workflowId: string;
  runId: string;
  verdict: RunVerdict | string | null | undefined;
  taskClass?: string | null | undefined;
  graphVersion: number;
  now?: number | undefined;
};

export type AddCaseResult =
  | { added: true; caseId: string; split: CaseSplit }
  | { added: false; reason: "no_verdict" | "invalid_input" | "duplicate" };

export type CaseCounts = {
  heldOut: number;
  working: number;
};

export type RotateHeldOutInput = {
  workflowId: string;
  caseIds: readonly string[];
  by: string;
  now?: number | undefined;
};

export type RotateHeldOutResult =
  | { ok: true; rotated: number }
  | { ok: false; rotated: 0; reason: string };

function mapCaseRow(row: Record<string, unknown>): EvolveCaseRow {
  return {
    caseId: String(row.case_id),
    workflowId: String(row.workflow_id),
    runId: String(row.run_id),
    split: String(row.split) as CaseSplit,
    taskClass: row.task_class === null || row.task_class === undefined ? null : String(row.task_class),
    verdict: String(row.verdict) as RunVerdict,
    graphVersion: Number(row.graph_version),
    addedAt: Number(row.added_at),
    rotatedAt: row.rotated_at === null || row.rotated_at === undefined ? null : Number(row.rotated_at),
  };
}

/** Deterministic working vs held-out split by SHA-256 of run id. */
export function splitForRunId(runId: string): CaseSplit {
  const ratio = parseInt(sha256Hex(runId).slice(0, 8), 16) / 0xffffffff;
  return ratio < EVOLVE_THRESHOLDS.heldOutShare ? "held_out" : "working";
}

/**
 * Adds a labelled run (`accept` or `reject`) to a workflow's case set.
 * Runs without a valid verdict are ignored; duplicate `run_id` entries are idempotent.
 */
export function addCase(
  db: EvolveCaseDb,
  input: AddCaseInput,
  log?: EvolveLogSink,
): AddCaseResult {
  if (!isRunVerdict(input.verdict)) {
    return { added: false, reason: "no_verdict" };
  }
  const workflowId = input.workflowId.trim();
  const runId = input.runId.trim();
  if (!workflowId || !runId || !Number.isFinite(input.graphVersion)) {
    return { added: false, reason: "invalid_input" };
  }

  const split = splitForRunId(runId);
  const caseId = `evc_${sha256Hex(runId).slice(0, 24)}`;
  const taskClass = input.taskClass?.trim() || null;
  const graphVersion = Math.trunc(input.graphVersion);
  const addedAt = input.now ?? Date.now();

  const res = db.prepare(
    `INSERT OR IGNORE INTO lane_pilot_evolve_case
      (case_id, workflow_id, run_id, split, task_class, verdict, graph_version, added_at, rotated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(caseId, workflowId, runId, split, taskClass, input.verdict, graphVersion, addedAt);

  if (res.changes === 0) {
    return { added: false, reason: "duplicate" };
  }
  log?.info?.(`evolve case added wf=${workflowId} run=${runId} split=${split}`);
  return { added: true, caseId, split };
}

/** Returns held-out and working case counts for a workflow. */
export function caseCounts(db: EvolveCaseDb, workflowId: string): CaseCounts {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN split = 'held_out' THEN 1 ELSE 0 END), 0) AS held_out,
       COALESCE(SUM(CASE WHEN split = 'working' THEN 1 ELSE 0 END), 0) AS working
     FROM lane_pilot_evolve_case
     WHERE workflow_id = ?`,
  ).get(workflowId) as { held_out?: unknown; working?: unknown } | undefined;
  return {
    heldOut: Number(row?.held_out ?? 0),
    working: Number(row?.working ?? 0),
  };
}

/** Lists working-set cases for a workflow (visible to hypothesis generation). */
export function workingCases(db: EvolveCaseDb, workflowId: string): EvolveCaseRow[] {
  const rows = db.prepare(
    `SELECT case_id, workflow_id, run_id, split, task_class, verdict, graph_version, added_at, rotated_at
     FROM lane_pilot_evolve_case
     WHERE workflow_id = ? AND split = 'working'
     ORDER BY added_at ASC, case_id ASC`,
  ).all(workflowId) as Array<Record<string, unknown>>;
  return rows.map(mapCaseRow);
}

/** Lists frozen held-out case IDs for a workflow (evaluator only; never import in hypothesis proposer). */
export function heldOutCaseIds(db: EvolveCaseDb, workflowId: string): string[] {
  const rows = db.prepare(
    `SELECT case_id
     FROM lane_pilot_evolve_case
     WHERE workflow_id = ? AND split = 'held_out'
     ORDER BY added_at ASC, case_id ASC`,
  ).all(workflowId) as Array<{ case_id: unknown }>;
  return rows.map((row) => String(row.case_id));
}

/** Lists frozen held-out case rows for a workflow (evaluator only; never import in hypothesis proposer). */
export function heldOutCases(db: EvolveCaseDb, workflowId: string): EvolveCaseRow[] {
  const rows = db.prepare(
    `SELECT case_id, workflow_id, run_id, split, task_class, verdict, graph_version, added_at, rotated_at
     FROM lane_pilot_evolve_case
     WHERE workflow_id = ? AND split = 'held_out'
     ORDER BY added_at ASC, case_id ASC`,
  ).all(workflowId) as Array<Record<string, unknown>>;
  return rows.map(mapCaseRow);
}

/**
 * Rotates frozen held-out cases back to the working set on explicit owner command.
 * Arms the rotation flag inside a single SQLite transaction and always resets it before returning.
 */
export function rotateHeldOut(
  db: EvolveCaseDb,
  input: RotateHeldOutInput,
  log?: EvolveLogSink,
): RotateHeldOutResult {
  const workflowId = input.workflowId.trim();
  const refuse = (reason: string): RotateHeldOutResult => {
    log?.warn?.(`evolve rotate refused wf=${workflowId || "unknown"}: ${reason}`);
    return { ok: false, rotated: 0, reason };
  };

  if (!workflowId) return refuse("missing workflowId");
  if (input.by !== "owner") return refuse("owner_only");

  const caseIds = [...new Set(input.caseIds.map((id) => id.trim()).filter(Boolean))];
  if (caseIds.length === 0) return refuse("no caseIds");

  const rotatedAt = input.now ?? Date.now();
  const rotated = db.transaction(() => {
    db.prepare(
      `INSERT INTO lane_pilot_evolve_flag (key, value) VALUES ('rotation', 'owner')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
    try {
      const stmt = db.prepare(
        `UPDATE lane_pilot_evolve_case
         SET split = 'working', rotated_at = ?
         WHERE workflow_id = ? AND split = 'held_out' AND case_id = ?`,
      );
      let changes = 0;
      for (const caseId of caseIds) {
        changes += stmt.run(rotatedAt, workflowId, caseId).changes;
      }
      return changes;
    } finally {
      db.prepare(`DELETE FROM lane_pilot_evolve_flag WHERE key = 'rotation'`).run();
    }
  })();

  if (rotated === 0) return refuse("no matching held_out cases");
  return { ok: true, rotated };
}
