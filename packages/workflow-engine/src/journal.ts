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

/** A live (running or waiting) run has a step of this node (the planner loop: a plan-revise step of the task's pipeline run). */
export function wfLiveRunHasStep(db: WfReadDb, runId: string, nodeId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id WHERE s.run_id=? AND s.node_id=? AND r.status IN ('running','waiting') LIMIT 1").get(runId, nodeId));
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

// ---- room-facing read/write helpers over the wf tables (raw SQL lives here, callers take named rows) ----

/** The run's workflow id (an errand check compares it to the errand graph's id). */
export function wfWorkflowIdOfRun(db: WfReadDb, runId: string): string | null {
  return (db.prepare("SELECT workflow_id FROM lane_pilot_wf_run WHERE id=?").get(runId) as { workflow_id: string } | undefined)?.workflow_id ?? null;
}

/** The run's idempotency key and parent (a walk climbs parents to find a phase or schedule key). */
export function wfRunIdemParent(db: WfReadDb, runId: string): { idem_key: string | null; parent_run_id: string | null } | undefined {
  return db.prepare("SELECT idem_key, parent_run_id FROM lane_pilot_wf_run WHERE id=?").get(runId) as { idem_key: string | null; parent_run_id: string | null } | undefined;
}

/** The status of the run an idempotency key points at (a retry key is taken only when the prior run ended badly). */
export function wfStatusByIdemKey(db: WfReadDb, idemKey: string): string | null {
  return (db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(idemKey) as { status: string } | undefined)?.status ?? null;
}

/** The earliest workflow run a Lane Pilot run linked inside a window (a route's outcome is the graph it started). */
export function wfEarliestLinkedRun(db: WfReadDb, linkRunId: string, from: number, to: number): { workflow_id: string; status: string } | undefined {
  return db.prepare(`SELECT workflow_id, status FROM lane_pilot_wf_run
    WHERE link_run_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at LIMIT 1`)
    .get(linkRunId, from, to) as { workflow_id: string; status: string } | undefined;
}

/** The child runs a subworkflow node spawned, in order (the run snapshot's children). */
export function wfChildRuns(db: WfReadDb, runId: string): Array<{ id: string; parent_step_key: string; workflow_id: string; status: string }> {
  return db.prepare("SELECT id, parent_step_key, workflow_id, status FROM lane_pilot_wf_run WHERE parent_run_id=? ORDER BY created_at, rowid")
    .all(runId) as Array<{ id: string; parent_step_key: string; workflow_id: string; status: string }>;
}

/** Every run of a workflow (optionally of a project) for the outcome tally. */
export function wfRunOutcomeRows(db: WfReadDb, workflowId: string, projectId?: string): Array<{ status: string; output_json: string | null; definition_json: string | null; created_at: number }> {
  const where = projectId ? "workflow_id=? AND project_id=?" : "workflow_id=?";
  const args = projectId ? [workflowId, projectId] : [workflowId];
  return db.prepare(`SELECT status, output_json, definition_json, created_at FROM lane_pilot_wf_run WHERE ${where}`)
    .all(...args) as Array<{ status: string; output_json: string | null; definition_json: string | null; created_at: number }>;
}

/** The finished runs of a workflow of a project, newest first: the phase's grill gate reads the latest outcome. */
export function wfFinishedRuns(db: WfReadDb, workflowId: string, projectId: string, since: number, limit = 10): Array<{ id: string; link_run_id: string | null; status: string; inputs_json: string | null; output_json: string | null; created_at: number }> {
  return db.prepare(`SELECT id, link_run_id, status, inputs_json, output_json, created_at FROM lane_pilot_wf_run
    WHERE workflow_id=? AND project_id=? AND created_at>=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(workflowId, projectId, since, limit) as Array<{ id: string; link_run_id: string | null; status: string; inputs_json: string | null; output_json: string | null; created_at: number }>;
}

/** The newest run of a workflow (optionally of a project). */
export function wfLastRun(db: WfReadDb, workflowId: string, projectId?: string): { id: string; status: string; created_at: number } | undefined {
  const where = projectId ? "workflow_id=? AND project_id=?" : "workflow_id=?";
  const args = projectId ? [workflowId, projectId] : [workflowId];
  return db.prepare(`SELECT id, status, created_at FROM lane_pilot_wf_run WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(...args) as { id: string; status: string; created_at: number } | undefined;
}

/** The workflow's recent runs, newest first (the library card's run list). */
export function wfRecentRuns(db: WfReadDb, workflowId: string, projectId: string | undefined, limit: number): Array<{ id: string; status: string; reason: string | null; mode: string | null; created_at: number; updated_at: number; tokens_used: number; cost_micro_usd: number; parent_run_id: string | null }> {
  return db.prepare(`SELECT id, status, reason, mode, created_at, updated_at, tokens_used, cost_micro_usd, parent_run_id FROM lane_pilot_wf_run
    WHERE workflow_id=?${projectId ? " AND project_id=?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...(projectId ? [workflowId, projectId, limit] : [workflowId, limit])) as Array<{ id: string; status: string; reason: string | null; mode: string | null; created_at: number; updated_at: number; tokens_used: number; cost_micro_usd: number; parent_run_id: string | null }>;
}

/** A page of a workflow's runs, newest first (the workflow_runs RPC; `before` pages backwards). */
export function wfRunPage(db: WfReadDb, input: { workflowId: string; projectId?: string; before?: number; limit: number }): Array<{ id: string; status: string; reason: string | null; mode: string | null; created_at: number; updated_at: number; tokens_used: number; cost_micro_usd: number; parent_run_id: string | null; steps_used: number }> {
  const args: unknown[] = [input.workflowId];
  let where = "workflow_id=?";
  if (input.projectId) { where += " AND project_id=?"; args.push(input.projectId); }
  if (input.before !== undefined) { where += " AND created_at<?"; args.push(input.before); }
  return db.prepare(`SELECT id, status, reason, mode, created_at, updated_at, tokens_used, cost_micro_usd, parent_run_id, steps_used FROM lane_pilot_wf_run
    WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, input.limit + 1) as Array<{ id: string; status: string; reason: string | null; mode: string | null; created_at: number;
    updated_at: number; tokens_used: number; cost_micro_usd: number; parent_run_id: string | null; steps_used: number }>;
}

/** Schedule bindings of a workflow across projects (the library card's schedules). */
export function wfTriggersOfWorkflow(db: WfReadDb, workflowId: string): Array<{ project_id: string; slot: number; automation_id: string }> {
  return db.prepare("SELECT project_id, slot, automation_id FROM lane_pilot_wf_trigger WHERE workflow_id=? ORDER BY project_id, slot")
    .all(workflowId) as Array<{ project_id: string; slot: number; automation_id: string }>;
}

/** Schedule bindings of a project (the sync compares them to the workflows' desired schedules). */
export function wfTriggersOfProject(db: WfReadDb, projectId: string): Array<{ workflow_id: string; slot: number; automation_id: string; signature: string }> {
  return db.prepare("SELECT workflow_id, slot, automation_id, signature FROM lane_pilot_wf_trigger WHERE project_id=?")
    .all(projectId) as Array<{ workflow_id: string; slot: number; automation_id: string; signature: string }>;
}

/** Every project that has a workflow schedule (the hourly sweep re-checks each). */
export function wfScheduledProjectIds(db: WfReadDb): string[] {
  return (db.prepare("SELECT DISTINCT project_id FROM lane_pilot_wf_trigger").all() as Array<{ project_id: string }>).map((row) => row.project_id);
}

/** Record the automation a schedule slot was synced to. */
export function wfUpsertTrigger(db: WfReadDb, row: { workflowId: string; projectId: string; slot: number; automationId: string; signature: string; now: number }): void {
  db.prepare("INSERT OR REPLACE INTO lane_pilot_wf_trigger(workflow_id, project_id, slot, automation_id, signature, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(row.workflowId, row.projectId, row.slot, row.automationId, row.signature, row.now, row.now);
}

/** Point a slot at the automation that was (re)created for it. */
export function wfSetTriggerAutomation(db: WfReadDb, automationId: string, key: { workflowId: string; projectId: string; slot: number }): void {
  db.prepare("UPDATE lane_pilot_wf_trigger SET automation_id=? WHERE workflow_id=? AND project_id=? AND slot=?")
    .run(automationId, key.workflowId, key.projectId, key.slot);
}

/** Record the signature the slot was last synced at. */
export function wfSetTriggerSignature(db: WfReadDb, signature: string, now: number, key: { workflowId: string; projectId: string; slot: number }): void {
  db.prepare("UPDATE lane_pilot_wf_trigger SET signature=?, updated_at=? WHERE workflow_id=? AND project_id=? AND slot=?")
    .run(signature, now, key.workflowId, key.projectId, key.slot);
}

/** Drop a schedule slot the workflow no longer wants. */
export function wfDeleteTrigger(db: WfReadDb, key: { workflowId: string; projectId: string; slot: number }): void {
  db.prepare("DELETE FROM lane_pilot_wf_trigger WHERE workflow_id=? AND project_id=? AND slot=?")
    .run(key.workflowId, key.projectId, key.slot);
}

/** Events of one kind on a run (a new audit's spawn key counts the earlier audits). */
export function wfCountRunEvents(db: WfReadDb, runId: string, kind: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_event WHERE run_id=? AND kind=?").get(runId, kind) as { n: number }).n;
}

/** The workflow run whose done `errand.spawn` effect named this helper thread. */
export function wfErrandSpawnRunOfThread(db: WfReadDb, threadId: string): string | null {
  return (db.prepare("SELECT run_id FROM lane_pilot_wf_effect WHERE kind='errand.spawn' AND state='done' AND json_extract(result_json,'$.threadId')=?")
    .get(threadId) as { run_id: string } | undefined)?.run_id ?? null;
}

/** Whether the workflow run exists (a tool call's idempotence check). */
export function wfRunExists(db: WfReadDb, runId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE id=?").get(runId));
}

/** Whether the step exists in the run. */
export function wfStepExists(db: WfReadDb, runId: string, stepKey: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_wf_step WHERE run_id=? AND step_key=?").get(runId, stepKey));
}

/** A run's status by its idempotency key, or null (the replay's once-a-day guard). */
export function wfRunStatusByIdem(db: WfReadDb, idemKey: string): string | null {
  return (db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(idemKey) as { status: string } | undefined)?.status ?? null;
}

/** A run's workflow definition JSON (the schedule executor's final-rule read). */
export function wfRunDefinitionJson(db: WfReadDb, id: string): string | undefined {
  return (db.prepare("SELECT definition_json FROM lane_pilot_wf_run WHERE id=?").get(id) as { definition_json?: string } | undefined)?.definition_json;
}

/** Live parentless graph runs linked to a run (the agent-switch guard). */
export function wfLiveRunsForLink(db: WfReadDb, linkRunId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM lane_pilot_wf_run WHERE link_run_id=? AND parent_run_id IS NULL AND status IN ('running','waiting')").get(linkRunId) as { n: number }).n;
}

/** The thread an errand.spawn effect recorded for a workflow run. */
export function wfErrandSpawnThreadId(db: WfReadDb, runId: string): string | null {
  return (db.prepare("SELECT json_extract(result_json,'$.threadId') AS thread FROM lane_pilot_wf_effect WHERE run_id=? AND kind='errand.spawn' AND state='done'").get(runId) as { thread: string | null } | undefined)?.thread ?? null;
}

/** Whether any effect's result JSON mentions the thread (the memory thread gate). */
export function wfEffectMentionsThread(db: WfReadDb, threadId: string): boolean {
  return db.prepare("SELECT 1 FROM lane_pilot_wf_effect WHERE result_json LIKE '%' || ? || '%'").get(threadId) !== undefined;
}

/** Whether a night.spawn effect's result JSON mentions the thread (the silent-thread check). */
export function wfNightSpawnMentionsThread(db: WfReadDb, threadId: string): boolean {
  return db.prepare("SELECT 1 FROM lane_pilot_wf_effect WHERE kind='night.spawn' AND result_json LIKE '%' || ? || '%'").get(threadId) !== undefined;
}

/** Every thread the done errand.spawn effects of a workflow run recorded (the schedule cost join). */
export function wfErrandSpawnThreadIds(db: WfReadDb, runId: string): string[] {
  return (db.prepare("SELECT json_extract(result_json,'$.threadId') AS thread FROM lane_pilot_wf_effect WHERE run_id=? AND kind='errand.spawn' AND state='done'").all(runId) as Array<{ thread: string | null }>)
    .map((row) => row.thread).filter((thread): thread is string => typeof thread === "string");
}

export const WF_RUN_TABLE = "lane_pilot_wf_run";

export function wfRunStatusByIdemKey(db: WfReadDb, key: string): string | undefined {
  return (db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(key) as { status: string } | undefined)?.status;
}

export function wfLiveRun(db: WfReadDb, workflowId: string, projectId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE workflow_id=? AND project_id=? AND status IN ('running','waiting') LIMIT 1").get(workflowId, projectId));
}

export function wfRunUsage(db: WfReadDb, runId: string): { tokens_used: number; cost_micro_usd: number } | undefined {
  return db.prepare("SELECT tokens_used, cost_micro_usd FROM lane_pilot_wf_run WHERE id=?").get(runId) as { tokens_used: number; cost_micro_usd: number } | undefined;
}

export function wfEffectResultJson(db: WfReadDb, runId: string, kind: string): string | null {
  return (db.prepare("SELECT result_json FROM lane_pilot_wf_effect WHERE run_id=? AND kind=? AND state='done'").get(runId, kind) as { result_json: string | null } | undefined)?.result_json ?? null;
}

export function wfEffectThreadId(db: WfReadDb, runId: string, kind: string): string | null {
  return (db.prepare("SELECT json_extract(result_json,'$.threadId') AS thread_id FROM lane_pilot_wf_effect WHERE run_id=? AND kind=? AND state='done' LIMIT 1")
    .get(runId, kind) as { thread_id: string | null } | undefined)?.thread_id ?? null;
}

export function listErrandWfRuns(db: WfReadDb, input: { since: number; projectId?: string | null; kind?: string | null; limit: number }): Array<{
  id: string; project_id: string | null; status: string; reason: string | null; inputs_json: string; output_json: string | null;
  tokens_used: number; cost_micro_usd: number; created_at: number; updated_at: number; thread_id: string | null; link_run_id: string | null;
}> {
  return db.prepare(`
    SELECT r.id, r.project_id, r.status, r.reason, r.inputs_json, r.output_json, r.tokens_used, r.cost_micro_usd, r.created_at, r.updated_at,
      (SELECT json_extract(e.result_json,'$.threadId') FROM lane_pilot_wf_effect e WHERE e.run_id=r.id AND e.kind='errand.spawn' AND e.state='done' LIMIT 1) AS thread_id,
      r.link_run_id
    FROM lane_pilot_wf_run r
    WHERE r.workflow_id='errand' AND r.created_at>=?
      ${input.projectId ? "AND r.project_id=?" : ""}
      ${input.kind ? "AND COALESCE(NULLIF(json_extract(r.inputs_json,'$.kind'),''),'none')=?" : ""}
    ORDER BY r.created_at DESC LIMIT ?`).all(input.since, ...(input.projectId ? [input.projectId] : []), ...(input.kind ? [input.kind] : []), input.limit) as Array<{
    id: string; project_id: string | null; status: string; reason: string | null; inputs_json: string; output_json: string | null;
    tokens_used: number; cost_micro_usd: number; created_at: number; updated_at: number; thread_id: string | null; link_run_id: string | null;
  }>;
}

export function listErrandKindRows(db: WfReadDb, since: number): Array<{ kind: string; status: string; reason: string | null; output_json: string | null; cost_micro_usd: number }> {
  return db.prepare("SELECT COALESCE(NULLIF(json_extract(inputs_json,'$.kind'),''),'none') AS kind, status, reason, output_json, cost_micro_usd FROM lane_pilot_wf_run WHERE workflow_id='errand' AND created_at>=?")
    .all(since) as Array<{ kind: string; status: string; reason: string | null; output_json: string | null; cost_micro_usd: number }>;
}

export function listGraphlessErrandRows(db: WfReadDb, since: number): Array<{ id: string; project_id: string | null; inputs_json: string; cost_micro_usd: number | null; thread_id: string | null }> {
  return db.prepare(`SELECT r.id, r.project_id, r.inputs_json, r.cost_micro_usd,
      (SELECT json_extract(e.result_json,'$.threadId') FROM lane_pilot_wf_effect e WHERE e.run_id=r.id AND e.kind='errand.spawn' AND e.state='done' LIMIT 1) AS thread_id
    FROM lane_pilot_wf_run r WHERE r.workflow_id='errand' AND r.created_at>=?`).all(since) as
    Array<{ id: string; project_id: string | null; inputs_json: string; cost_micro_usd: number | null; thread_id: string | null }>;
}

export function listFailedWfRuns(db: WfReadDb, input: { since: number; until: number; failed: readonly string[]; skipped: readonly string[] }): Array<{
  id: string; workflow_id: string; status: string; reason: string | null; updated_at: number; harness_version: string | null; project_id: string | null; link_task_id: string | null;
}> {
  return db.prepare(`SELECT r.id, r.workflow_id, r.status, r.reason, r.updated_at, r.harness_version, r.project_id, r.link_task_id
    FROM lane_pilot_wf_run r
    WHERE r.updated_at>=? AND r.updated_at<? AND r.status IN (${input.failed.map(() => "?").join(",")}) AND r.workflow_id NOT IN (${input.skipped.map(() => "?").join(",")})
      AND NOT (r.workflow_id='lp.browser-qa' AND COALESCE(r.reason,'') LIKE 'step_failed:verdict%')
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_wf_run c WHERE c.parent_run_id=r.id AND c.status IN (${input.failed.map(() => "?").join(",")}))
    ORDER BY r.updated_at`).all(input.since, input.until, ...input.failed, ...input.skipped, ...input.failed) as Array<{
    id: string; workflow_id: string; status: string; reason: string | null; updated_at: number; harness_version: string | null; project_id: string | null; link_task_id: string | null;
  }>;
}

export function listErrandRuns(db: WfReadDb): Array<{ id: string; project_id: string | null; status: string; reason: string | null; output_json: string | null; inputs_json: string; created_at: number }> {
  return db.prepare(`SELECT r.id, r.project_id, r.status, r.reason, r.output_json, r.inputs_json, r.created_at
    FROM lane_pilot_wf_run r WHERE r.workflow_id='errand' ORDER BY r.created_at DESC`).all() as
    Array<{ id: string; project_id: string | null; status: string; reason: string | null; output_json: string | null; inputs_json: string; created_at: number }>;
}

export function listWfRunsSince(db: WfReadDb, input: { since: number; projectId?: string | null }): RunRow[] {
  return db.prepare(`
    SELECT r.* FROM lane_pilot_wf_run r
    WHERE r.created_at>=? AND r.workflow_id='errand'
      ${input.projectId ? "AND r.project_id=?" : ""}
    ORDER BY r.created_at ASC`).all(input.since, ...(input.projectId ? [input.projectId] : [])) as RunRow[];
}

export function listWfRunsByIdsOrdered(db: WfReadDb, ids: readonly string[], projectId?: string | null): RunRow[] {
  const rows: RunRow[] = [];
  for (let at = 0; at < ids.length; at += 400) {
    const chunk = ids.slice(at, at + 400);
    if (!chunk.length) break;
    rows.push(...(db.prepare(`SELECT r.* FROM lane_pilot_wf_run r WHERE r.id IN (${chunk.map(() => "?").join(",")}) ${projectId ? "AND r.project_id=?" : ""}`)
      .all(...chunk, ...(projectId ? [projectId] : [])) as RunRow[]));
  }
  return rows.sort((a, b) => a.created_at - b.created_at);
}

export function wfTerminalByIdemKey(db: WfReadDb, key: string): { status: string } | undefined {
  return db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(key) as { status: string } | undefined;
}
