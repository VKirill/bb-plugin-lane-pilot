import type Database from "better-sqlite3";

import { sha256Hex } from "@lane-pilot/kit";

/**
 * The workflow journal: run, step, join arrival, effect and an append-only event log. Every change of a step is a
 * conditional UPDATE along `STEP_TRANSITIONS`, so a second writer loses cleanly and an illegal move is refused and logged.
 * Appended to the plugin's migrations (append only).
 */
export const workflowMigrations: string[] = [
  `CREATE TABLE lane_pilot_wf_run (
    id TEXT PRIMARY KEY,
    idem_key TEXT UNIQUE,
    workflow_id TEXT NOT NULL,
    workflow_version INTEGER NOT NULL,
    workflow_sha256 TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    project_id TEXT,
    link_run_id TEXT,
    link_task_id TEXT,
    link_attempt_id TEXT,
    parent_run_id TEXT,
    parent_step_key TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('running','waiting','succeeded','failed','blocked','interrupted','canceled')),
    reason TEXT,
    mode TEXT,
    inputs_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    harness_version TEXT,
    steps_used INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    wait_ms INTEGER NOT NULL DEFAULT 0,
    owner_id TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX lane_pilot_wf_run_child ON lane_pilot_wf_run(parent_run_id, parent_step_key) WHERE parent_run_id IS NOT NULL`,
  `CREATE INDEX lane_pilot_wf_run_status ON lane_pilot_wf_run(status)`,
  `CREATE INDEX lane_pilot_wf_run_link ON lane_pilot_wf_run(link_run_id, link_task_id)`,
  `CREATE TABLE lane_pilot_wf_step (
    run_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    origin TEXT NOT NULL,
    node_id TEXT NOT NULL,
    visit INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    parent_key TEXT,
    edge_index INTEGER,
    state TEXT NOT NULL CHECK(state IN ('pending','running','waiting','succeeded','failed','skipped','interrupted','canceled')),
    attempt INTEGER NOT NULL DEFAULT 0,
    input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    error TEXT,
    await_json TEXT,
    spawn_key TEXT,
    harness_version TEXT,
    receipt_json TEXT,
    routed INTEGER NOT NULL DEFAULT 0,
    fan_count INTEGER,
    started_at INTEGER,
    ended_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, step_key)
  )`,
  `CREATE UNIQUE INDEX lane_pilot_wf_step_origin ON lane_pilot_wf_step(run_id, origin)`,
  `CREATE INDEX lane_pilot_wf_step_state ON lane_pilot_wf_step(state)`,
  `CREATE TABLE lane_pilot_wf_arrival (
    run_id TEXT NOT NULL,
    group_key TEXT NOT NULL,
    branch INTEGER NOT NULL,
    from_step TEXT NOT NULL,
    data_json TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY(run_id, group_key, branch)
  )`,
  `CREATE TABLE lane_pilot_wf_effect (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    effect_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('intended','done','failed','unknown')),
    intent_json TEXT,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(run_id, step_key, effect_key)
  )`,
  `CREATE TABLE lane_pilot_wf_event (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step_key TEXT,
    kind TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT,
    detail TEXT,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_wf_event_run ON lane_pilot_wf_event(run_id, seq)`,
  `CREATE TRIGGER lane_pilot_wf_event_no_update BEFORE UPDATE ON lane_pilot_wf_event BEGIN SELECT RAISE(ABORT, 'workflow events are append-only'); END`,
  `CREATE TRIGGER lane_pilot_wf_event_no_delete BEFORE DELETE ON lane_pilot_wf_event BEGIN SELECT RAISE(ABORT, 'workflow events are append-only'); END`,
];

/** `not_verified` is added by a later migration: the CREATE above is already applied and must not change. */
export const RUN_STATUSES = ["running", "waiting", "succeeded", "failed", "blocked", "interrupted", "canceled", "not_verified"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_RUN: readonly RunStatus[] = ["succeeded", "failed", "blocked", "interrupted", "canceled", "not_verified"];

export const STEP_STATES = ["pending", "running", "waiting", "succeeded", "failed", "skipped", "interrupted", "canceled"] as const;
export type StepState = (typeof STEP_STATES)[number];

/** Which state a step may move to from which; `running -> pending` is the resume of a reentrant step after a reload. */
export const STEP_TRANSITIONS: Record<StepState, readonly StepState[]> = {
  pending: ["running", "skipped", "canceled"],
  running: ["succeeded", "failed", "waiting", "interrupted", "canceled", "pending"],
  waiting: ["succeeded", "failed", "canceled", "interrupted"],
  interrupted: ["running", "canceled"],
  succeeded: [], failed: [], skipped: [], canceled: [],
};

export type RunRow = {
  id: string; idem_key: string | null; workflow_id: string; workflow_version: number; workflow_sha256: string; definition_json: string;
  project_id: string | null; link_run_id: string | null; link_task_id: string | null; link_attempt_id: string | null;
  parent_run_id: string | null; parent_step_key: string | null; depth: number; status: RunStatus; reason: string | null; mode: string | null;
  inputs_json: string; output_json: string | null; harness_version: string | null;
  steps_used: number; tokens_used: number; cost_micro_usd: number; wait_ms: number; owner_id: string | null; lease_until: number; created_at: number; updated_at: number;
  /** K7: the goals of the run as JSON (see goals.ts); null for a run started without. */
  goals_json?: string | null;
};

export type StepRow = {
  run_id: string; step_key: string; origin: string; node_id: string; visit: number; scope: string; parent_key: string | null; edge_index: number | null;
  state: StepState; attempt: number; input_json: string; output_json: string | null; error: string | null; await_json: string | null;
  spawn_key: string | null; harness_version: string | null; receipt_json: string | null; routed: number; fan_count: number | null;
  started_at: number | null; ended_at: number | null; updated_at: number;
};

export type EffectRow = {
  id: string; run_id: string; step_key: string; effect_key: string; kind: string; state: "intended" | "done" | "failed" | "unknown";
  intent_json: string | null; result_json: string | null; created_at: number; updated_at: number;
};

export const sha256 = (text: string): string => sha256Hex(text);
/** A short stable id from parts: the same parts always give the same id, so re-routing after a crash creates nothing twice. */
export const stableId = (...parts: Array<string | number>): string => sha256(parts.join("\u0000")).slice(0, 16);

/** The journal's database access. No logic about graphs here. */
export function createJournal(db: Database.Database, now: () => number = Date.now, onEvent?: (runId: string) => void) {
  const getRun = (id: string) => db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(id) as RunRow | undefined;
  const getStep = (runId: string, stepKey: string) => db.prepare("SELECT * FROM lane_pilot_wf_step WHERE run_id=? AND step_key=?").get(runId, stepKey) as StepRow | undefined;
  const steps = (runId: string) => db.prepare("SELECT * FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid").all(runId) as StepRow[];

  function event(runId: string, stepKey: string | null, kind: string, from: string | null, to: string | null, detail?: unknown): void {
    db.prepare("INSERT INTO lane_pilot_wf_event(run_id,step_key,kind,from_state,to_state,detail,at) VALUES (?,?,?,?,?,?,?)")
      .run(runId, stepKey, kind, from, to, detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail), now());
    // A screen watching the run reads again; a failing listener never fails the transition.
    try { onEvent?.(runId); } catch { /* the journal is the truth, the signal is a courtesy */ }
  }

  /** Moves a step along the table; false (and a logged refusal) when it is no longer in `from`. */
  function moveStep(runId: string, stepKey: string, from: StepState | readonly StepState[], to: StepState, patch: Partial<Pick<StepRow,
    "attempt" | "output_json" | "error" | "await_json" | "spawn_key" | "harness_version" | "receipt_json" | "fan_count" | "input_json">> & { started?: boolean; ended?: boolean } = {}): boolean {
    const froms: StepState[] = typeof from === "string" ? [from] : [...from];
    for (const state of froms) if (!STEP_TRANSITIONS[state].includes(to)) throw new Error(`illegal workflow step transition ${state} -> ${to}`);
    const sets = ["state=?", "updated_at=?"], values: unknown[] = [to, now()];
    for (const [column, value] of Object.entries(patch)) {
      if (column === "started" || column === "ended" || value === undefined) continue;
      sets.push(`${column}=?`); values.push(value);
    }
    if (patch.started) { sets.push("started_at=COALESCE(started_at,?)"); values.push(now()); }
    if (patch.ended) { sets.push("ended_at=?"); values.push(now()); }
    const result = db.prepare(`UPDATE lane_pilot_wf_step SET ${sets.join(",")} WHERE run_id=? AND step_key=? AND state IN (${froms.map(() => "?").join(",")})`)
      .run(...values, runId, stepKey, ...froms);
    if (result.changes === 0) { event(runId, stepKey, "refused", froms.join("|"), to, "step was not in the expected state"); return false; }
    event(runId, stepKey, "step", froms.length === 1 ? froms[0]! : froms.join("|"), to, patch.error ?? undefined);
    return true;
  }

  function setRunStatus(runId: string, from: readonly RunStatus[], to: RunStatus, reason: string | null, extra: { output?: unknown } = {}): boolean {
    const result = db.prepare(`UPDATE lane_pilot_wf_run SET status=?, reason=?, updated_at=?${extra.output !== undefined ? ", output_json=?" : ""} WHERE id=? AND status IN (${from.map(() => "?").join(",")})`)
      .run(to, reason, now(), ...(extra.output !== undefined ? [JSON.stringify(extra.output)] : []), runId, ...from);
    if (result.changes === 0) return false;
    event(runId, null, "run", from.join("|"), to, reason ?? undefined);
    return true;
  }

  return { db, now, getRun, getStep, steps, event, moveStep, setRunStatus };
}

export type Journal = ReturnType<typeof createJournal>;

/** The thread a step's receipt names (its worker thread), null when the receipt has none or does not parse. */
type WfReadDb = Pick<Database.Database, "prepare">;

/** A run row by id. */
export function wfRunRow(db: WfReadDb, id: string): RunRow | undefined {
  return db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(id) as RunRow | undefined;
}

export function receiptThreadId(receiptJson: string | null | undefined): string | null {
  if (!receiptJson) return null;
  try {
    const id = (JSON.parse(receiptJson) as { threadId?: unknown }).threadId;
    return typeof id === "string" ? id : null;
  } catch { return null; }
}

/** The node a run is on: its running or waiting step's node, latest first. */
export function wfCurrentNodeId(db: WfReadDb, runId: string): string | null {
  return (db.prepare("SELECT node_id FROM lane_pilot_wf_step WHERE run_id=? AND state IN ('running','waiting') ORDER BY rowid DESC LIMIT 1")
    .get(runId) as { node_id: string } | undefined)?.node_id ?? null;
}

/** A live (running or waiting) run exists under this idempotency-key LIKE. */
export function wfLiveRunWithIdem(db: WfReadDb, idemLike: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS live FROM lane_pilot_wf_run WHERE idem_key LIKE ? AND status IN ('running','waiting') LIMIT 1").get(idemLike));
}

/** A task's lp-task-pipeline run is still open (running or waiting). */
export function wfLivePipelineRun(db: WfReadDb, linkRunId: string, linkTaskId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline' AND link_run_id=? AND link_task_id=? AND status IN ('running','waiting')").get(linkRunId, linkTaskId));
}

/** The newest lp-task-pipeline run id of a task (linked to the Lane Pilot run and the task), or null. */
export function wfLatestPipelineRunId(db: WfReadDb, linkRunId: string, linkTaskId: string): string | null {
  return (db.prepare("SELECT id FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline' AND link_run_id=? AND link_task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(linkRunId, linkTaskId) as { id: string } | undefined)?.id ?? null;
}

/** The step key of a run's `writer` node, newest visit first. */
export function wfPipelineWriterStepKey(db: WfReadDb, runId: string): string | null {
  return (db.prepare("SELECT step_key FROM lane_pilot_wf_step WHERE run_id=? AND node_id='writer' ORDER BY visit DESC LIMIT 1")
    .get(runId) as { step_key: string } | undefined)?.step_key ?? null;
}

/** A run's stored inputs JSON. */
export function wfRunInputsJson(db: WfReadDb, runId: string): string | null {
  return (db.prepare("SELECT inputs_json FROM lane_pilot_wf_run WHERE id=?").get(runId) as { inputs_json: string } | undefined)?.inputs_json ?? null;
}

/** Inputs JSON of every run under an exact idem key or a LIKE pattern, oldest first. */
export function wfRunInputsByKey(db: WfReadDb, idemKey: string, idemLike: string): string[] {
  return (db.prepare("SELECT inputs_json FROM lane_pilot_wf_run WHERE idem_key=? OR idem_key LIKE ? ORDER BY created_at")
    .all(idemKey, idemLike) as Array<{ inputs_json: string }>).map((row) => row.inputs_json);
}

/** Idem key and status of every run under an idem-key LIKE, newest first. */
export function wfRunsByIdemPrefix(db: WfReadDb, idemLike: string): Array<{ idem_key: string; status: string }> {
  return db.prepare("SELECT idem_key, status FROM lane_pilot_wf_run WHERE idem_key LIKE ? ORDER BY created_at DESC")
    .all(idemLike) as Array<{ idem_key: string; status: string }>;
}

/** A run's project, optionally checked against its workflow. */
export function wfRunProjectId(db: WfReadDb, runId: string, workflowId?: string): string | null {
  const row = (workflowId === undefined
    ? db.prepare("SELECT project_id FROM lane_pilot_wf_run WHERE id=?").get(runId)
    : db.prepare("SELECT project_id FROM lane_pilot_wf_run WHERE id=? AND workflow_id=?").get(runId, workflowId)) as { project_id: string | null } | undefined;
  return row?.project_id ?? null;
}

/** A run's status, or null. */
export function wfRunStatus(db: WfReadDb, runId: string): string | null {
  return (db.prepare("SELECT status FROM lane_pilot_wf_run WHERE id=?").get(runId) as { status: string } | undefined)?.status ?? null;
}

/** The newest succeeded step of a node in a run. */
export function wfLatestSucceededStep(db: WfReadDb, runId: string, nodeId: string): { input_json: string; receipt_json: string | null } | undefined {
  return db.prepare("SELECT input_json, receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id=? AND state='succeeded' ORDER BY rowid DESC LIMIT 1")
    .get(runId, nodeId) as { input_json: string; receipt_json: string | null } | undefined;
}

/** Top-level workflow runs a board lists: own work (no task link) still live or touched since a time, newest first. */
export function wfBoardRuns(db: WfReadDb, input: { projectId?: string | null; doneSince: number; limit: number }): Array<{
  id: string; workflow_id: string; definition_json: string; project_id: string | null; status: string; reason: string | null; created_at: number; updated_at: number;
}> {
  return db.prepare(`SELECT id, workflow_id, definition_json, project_id, status, reason, created_at, updated_at FROM lane_pilot_wf_run
    WHERE depth=0 AND link_task_id IS NULL AND (status NOT IN ('succeeded','canceled') OR updated_at>=?) ${input.projectId ? "AND project_id=?" : ""}
    ORDER BY updated_at DESC LIMIT ?`).all(input.doneSince, ...(input.projectId ? [input.projectId] : []), input.limit) as Array<{
    id: string; workflow_id: string; definition_json: string; project_id: string | null; status: string; reason: string | null; created_at: number; updated_at: number;
  }>;
}

/** Runs of a workflow under a shipped version since a time, finished or running (the wall's graph-class recurrence). */
export function wfRunsOfWorkflow(db: WfReadDb, workflowId: string, input: { harnessVersion: string; since: number }): Array<{ status: string; reason: string | null }> {
  return db.prepare("SELECT status, reason FROM lane_pilot_wf_run WHERE workflow_id=? AND harness_version=? AND created_at>=? AND status NOT IN ('running','waiting','canceled')")
    .all(workflowId, input.harnessVersion, input.since) as Array<{ status: string; reason: string | null }>;
}

/** The latest failed or interrupted step of a run. */
export function wfFailedStepOfRun(db: WfReadDb, runId: string): { node_id: string; error: string | null } | undefined {
  return db.prepare("SELECT node_id, error FROM lane_pilot_wf_step WHERE run_id=? AND state IN ('failed','interrupted') ORDER BY updated_at DESC LIMIT 1")
    .get(runId) as { node_id: string; error: string | null } | undefined;
}
