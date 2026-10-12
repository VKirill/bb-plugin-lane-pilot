import type { LanePilotDatabase } from "../../storage";

/**
 * The «Tasks» board: every Lane Pilot task and workflow run of one project or of all of them, in the columns the BB Tasks
 * board had (queue, at work, checks, blocked, done), so the owner sees all work without the Tasks plugin (retired 2026-10-12).
 */
export type BoardColumn = "queued" | "running" | "checking" | "blocked" | "done";
export type BoardItem = {
  kind: "task" | "workflow"; key: string; runId: string; taskId: string | null; title: string; projectId: string | null;
  pmThreadId: string | null; column: BoardColumn; state: string; detail: string | null; attemptNo: number; threadId: string | null;
  attemptId: string | null; updatedAt: number;
};

const AT_WORK = new Set(["spawn_requested", "spawn_unknown", "running", "cancel_requested", "validation_failed"]);
/** Stages after the writer: while one runs, or once the writer's stage passed, the task is in checks. */
const CHECK_STAGES = new Set(["verification", "code-critique", "acceptance-receipt", "browser-qa", "docs-maintenance"]);
const PLAN_STAGE_LABEL: Record<string, string> = { "pm-read": "reading the project", "plan-critique": "plan critique", "specialist-review": "specialist review", "run-gate": "run gate" };

const clip = (text: string | null | undefined, max = 240) => (text ? text.replace(/\s+/g, " ").trim().slice(0, max) : null);
const titleOf = (json: string, fallback: string) => {
  try { const title = (JSON.parse(json) as { title?: unknown; name?: unknown }).title ?? (JSON.parse(json) as { name?: unknown }).name; return typeof title === "string" && title ? title : fallback; } catch { return fallback; }
};

export function buildTaskBoard(db: LanePilotDatabase, input: { projectId?: string | null; doneSince: number; limit?: number }): BoardItem[] {
  const limit = input.limit ?? 400;
  const scope = input.projectId ? "AND r.project_id=?" : "";
  const args = input.projectId ? [input.projectId] : [];
  const tasks = db.prepare(`SELECT a.id AS attempt_id, a.run_id, a.task_id, a.state, a.reason, a.thread_id, a.attempt_no, a.updated_at,
      t.contract_json, r.project_id, r.pm_thread_id
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    LEFT JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE a.attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)
      AND (a.state NOT IN ('accepted','canceled') OR a.updated_at>=?) ${scope}
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt c JOIN lane_pilot_run rc ON rc.id=c.run_id
        WHERE rc.project_id=r.project_id AND c.created_at>=a.created_at AND substr(c.task_id,1,length(a.task_id)+1)=a.task_id || '.')
    ORDER BY a.updated_at DESC LIMIT ?`).all(input.doneSince, ...args, limit) as Array<{
    attempt_id: string; run_id: string; task_id: string; state: string; reason: string | null; thread_id: string | null; attempt_no: number;
    updated_at: number; contract_json: string | null; project_id: string; pm_thread_id: string | null;
  }>;
  const stagesOf = db.prepare("SELECT stage_id, state, reason FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=?");
  const items: BoardItem[] = tasks.map((row) => {
    const stages = stagesOf.all(row.run_id, row.task_id) as Array<{ stage_id: string; state: string; reason: string | null }>;
    const writer = stages.find((stage) => stage.stage_id === "writer-agent");
    const checking = stages.find((stage) => CHECK_STAGES.has(stage.stage_id) && stage.state === "running");
    const planning = stages.find((stage) => PLAN_STAGE_LABEL[stage.stage_id] && stage.state === "running");
    let column: BoardColumn;
    let detail: string | null = null;
    if (row.state === "accepted" || row.state === "canceled") column = "done";
    else if (row.state === "blocked") { column = "blocked"; detail = clip(row.reason); }
    else if (row.state === "queued") {
      column = "queued";
      detail = planning ? PLAN_STAGE_LABEL[planning.stage_id]! : writer?.state === "pending" ? clip(writer.reason, 160) : null;
    } else if (AT_WORK.has(row.state) && (checking || writer?.state === "passed")) { column = "checking"; detail = checking?.stage_id ?? "acceptance"; }
    else { column = "running"; detail = row.state === "validation_failed" ? clip(`retry: ${row.reason ?? ""}`, 160) : null; }
    return {
      kind: "task", key: `task:${row.run_id}:${row.task_id}`, runId: row.run_id, taskId: row.task_id,
      title: row.contract_json ? titleOf(row.contract_json, row.task_id) : row.task_id, projectId: row.project_id, pmThreadId: row.pm_thread_id,
      column, state: row.state, detail, attemptNo: row.attempt_no, threadId: row.thread_id, attemptId: row.attempt_id, updatedAt: row.updated_at,
    };
  });
  // Workflow runs the owner or a PM started (insights, research, reels...); a task's own pipeline run is part of the task above.
  const flows = db.prepare(`SELECT id, workflow_id, definition_json, project_id, status, reason, updated_at FROM lane_pilot_wf_run
    WHERE depth=0 AND link_task_id IS NULL AND (status NOT IN ('succeeded','canceled') OR updated_at>=?) ${input.projectId ? "AND project_id=?" : ""}
    ORDER BY updated_at DESC LIMIT ?`).all(input.doneSince, ...args, limit) as Array<{
    id: string; workflow_id: string; definition_json: string; project_id: string | null; status: string; reason: string | null; updated_at: number;
  }>;
  for (const row of flows) {
    const column: BoardColumn = row.status === "running" ? "running" : row.status === "waiting" ? "queued"
      : row.status === "succeeded" || row.status === "canceled" ? "done" : "blocked";
    items.push({
      kind: "workflow", key: `workflow:${row.id}`, runId: row.id, taskId: null, title: titleOf(row.definition_json, row.workflow_id),
      projectId: row.project_id, pmThreadId: null, column, state: row.status, detail: column === "blocked" ? clip(row.reason) : row.workflow_id,
      attemptNo: 0, threadId: null, attemptId: null, updatedAt: row.updated_at,
    });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export type CardThread = { id: string; role: string; title: string | null; status: string | null; children: CardThread[] };
export type TaskCard = {
  kind: "task" | "workflow"; title: string; id: string; projectId: string | null; state: string; reason: string | null;
  contract: { objective: string | null; acceptance: string[]; ownsPaths: string[]; expectedOutputs: string[]; dependsOn: string[]; checks: string[] } | null;
  plan: string | null;
  stages: Array<{ id: string; state: string; reason: string | null; threadId: string | null; model: string | null; updatedAt: number }>;
  attempts: Array<{ id: string; no: number; state: string; reason: string | null; threadId: string | null; createdAt: number; updatedAt: number }>;
  threads: CardThread | null;
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** What a card shows from the database; the thread tree is filled by the caller, which can ask BB for child threads. */
export function readTaskCard(db: LanePilotDatabase, input: { runId: string; taskId: string | null }): (TaskCard & { pmThreadId: string | null; roots: Array<{ id: string; role: string }> }) | null {
  if (input.taskId === null) {
    const run = db.prepare("SELECT id, workflow_id, definition_json, project_id, status, reason FROM lane_pilot_wf_run WHERE id=?").get(input.runId) as
      { id: string; workflow_id: string; definition_json: string; project_id: string | null; status: string; reason: string | null } | undefined;
    if (!run) return null;
    const steps = db.prepare("SELECT step_key, node_id, state, error, receipt_json, rowid FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid").all(run.id) as
      Array<{ step_key: string; node_id: string; state: string; error: string | null; receipt_json: string | null }>;
    const threadOf = (json: string | null) => { const found = /"threadId"\s*:\s*"(thr_[A-Za-z0-9]+)"/.exec(json ?? ""); return found?.[1] ?? null; };
    const stageRows = steps.map((step) => ({ id: step.node_id, state: step.state, reason: clip(step.error), threadId: threadOf(step.receipt_json), model: null, updatedAt: 0 }));
    return {
      kind: "workflow", title: titleOf(run.definition_json, run.workflow_id), id: run.workflow_id, projectId: run.project_id, state: run.status, reason: clip(run.reason, 1000),
      contract: null, plan: null, stages: stageRows, attempts: [], threads: null, pmThreadId: null,
      roots: stageRows.filter((row) => row.threadId).map((row) => ({ id: row.threadId!, role: row.id })),
    };
  }
  const run = db.prepare("SELECT project_id, pm_thread_id FROM lane_pilot_run WHERE id=?").get(input.runId) as { project_id: string; pm_thread_id: string | null } | undefined;
  const task = db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id=?").get(input.taskId) as { contract_json: string } | undefined;
  if (!run || !task) return null;
  let contract: Record<string, unknown> = {};
  try { contract = JSON.parse(task.contract_json) as Record<string, unknown>; } catch { /* a broken contract still shows its stages */ }
  const plan = db.prepare("SELECT plan FROM lane_pilot_task_plan WHERE task_id=?").get(input.taskId) as { plan?: string } | undefined;
  const stages = (db.prepare("SELECT stage_id, state, reason, thread_id, model, updated_at FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? ORDER BY updated_at").all(input.runId, input.taskId) as
    Array<{ stage_id: string; state: string; reason: string | null; thread_id: string | null; model: string | null; updated_at: number }>)
    .map((row) => ({ id: row.stage_id, state: row.state, reason: clip(row.reason, 600), threadId: row.thread_id, model: row.model, updatedAt: row.updated_at }));
  const attempts = (db.prepare("SELECT id, attempt_no, state, reason, thread_id, created_at, updated_at FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY attempt_no").all(input.runId, input.taskId) as
    Array<{ id: string; attempt_no: number; state: string; reason: string | null; thread_id: string | null; created_at: number; updated_at: number }>)
    .map((row) => ({ id: row.id, no: row.attempt_no, state: row.state, reason: clip(row.reason, 600), threadId: row.thread_id, createdAt: row.created_at, updatedAt: row.updated_at }));
  const last = attempts.at(-1);
  const roots = new Map<string, string>();
  for (const attempt of attempts) if (attempt.threadId) roots.set(attempt.threadId, `writer · attempt ${attempt.no}`);
  for (const stage of stages) if (stage.threadId && !roots.has(stage.threadId)) roots.set(stage.threadId, stage.id);
  const checks = Array.isArray(contract.verification) ? (contract.verification as Array<{ command?: unknown }>).map((check) => check.command).filter((item): item is string => typeof item === "string") : [];
  return {
    kind: "task", title: typeof contract.title === "string" && contract.title ? contract.title : input.taskId, id: input.taskId, projectId: run.project_id,
    state: last?.state ?? "queued", reason: last?.reason ?? null,
    contract: { objective: typeof contract.objective === "string" ? contract.objective : null, acceptance: strings(contract.acceptance), ownsPaths: strings(contract.owns_paths),
      expectedOutputs: strings(contract.expected_outputs), dependsOn: strings(contract.depends_on), checks },
    plan: plan?.plan ?? null, stages, attempts, threads: null, pmThreadId: run.pm_thread_id,
    roots: [...roots].map(([id, role]) => ({ id, role })),
  };
}
