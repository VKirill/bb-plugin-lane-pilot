import type { LanePilotDatabase } from "../../storage";
import { taskFamily } from "../failure-class";

/**
 * The «Tasks» board: every Lane Pilot task and workflow run of one project or of all of them, in the columns the BB Tasks
 * board had (queue, at work, checks, blocked, done), so the owner sees all work without the Tasks plugin (retired 2026-10-12).
 * Work in progress of open runs is always shown; blocked, stuck and done tasks only for the chosen period, or the board fills
 * with weeks of tasks no one will send again (hub, 2026-10-12: 340 such latest attempts).
 */
export type BoardColumn = "queued" | "running" | "checking" | "blocked" | "done";
export type TaskKind = "feature" | "fix" | "check" | "docs" | "refactor" | "research" | "chore";
/**
 * Where a card's work is, in one word the board translates: planning (a stage before the writer), waiting (depends_on or
 * the queue of a folder or files), writing, checking, retrying (a failed attempt whose retry may still come), blocked,
 * stuck (no retry followed), closed (its run was closed under it), accepted, canceled; a chain: running, waiting, failed.
 */
export type BoardPhase = "queued" | "planning" | "waiting" | "writing" | "checking" | "retrying" | "blocked" | "stuck" | "closed" | "accepted" | "canceled" | "chain";
export type BoardItem = {
  kind: "task" | "workflow"; key: string; runId: string; taskId: string | null;
  /** The owner-facing title (`display_title` of the task standard) or, for older tasks, the technical one. */
  title: string; techTitle: string | null; taskKind: TaskKind | null; area: string | null; objective: string | null;
  projectId: string | null; pmThreadId: string | null; column: BoardColumn; state: string; phase: BoardPhase;
  /** The stage the phase is in (`plan-critique`, `verification`...), its model and since when. */
  stage: string | null; model: string | null; since: number | null;
  waitingFor: string[]; detail: string | null; attemptNo: number; threadId: string | null; attemptId: string | null; updatedAt: number;
};

const LIVE = new Set(["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"]);
/** A failed attempt is followed by its retry within moments; one that stays the latest longer than this got none and is stuck. */
const RETRY_GRACE_MS = 30 * 60_000;
/** Stages after the writer: while one runs, or once the writer's stage passed, the task is in checks. */
const CHECK_STAGES = new Set(["verification", "code-critique", "acceptance-receipt", "browser-qa", "docs-maintenance"]);
const PLAN_STAGES = new Set(["pm-read", "plan-critique", "specialist-review", "run-gate"]);
const PIPELINE = ["pm-read", "plan-critique", "run-gate", "specialist-review", "writer-agent", "verification", "code-critique", "acceptance-receipt", "browser-qa", "docs-maintenance", "project-life", "memory-maintenance"];
const stageOrder = (id: string) => { const index = PIPELINE.indexOf(id); return index < 0 ? PIPELINE.length : index; };
const KINDS = new Set<TaskKind>(["feature", "fix", "check", "docs", "refactor", "research", "chore"]);

const clip = (text: string | null | undefined, max = 240) => (text ? text.replace(/\s+/g, " ").trim().slice(0, max) : null);
const parse = (json: string | null): Record<string, unknown> => { try { return json ? JSON.parse(json) as Record<string, unknown> : {}; } catch { return {}; } };
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
/** A workflow names itself as a string or as `{ en, ru }`. */
const nameOf = (value: unknown, fallback: string) => text(value) ?? (value && typeof value === "object" ? text((value as { ru?: unknown }).ru) ?? text((value as { en?: unknown }).en) : null) ?? fallback;

/** A task without `kind` (older than the task standard): read from its id and title. */
export function inferTaskKind(id: string, title: string): TaskKind {
  const words = `${id} ${title}`.toLowerCase();
  if (/mainfix|\bfix|repair|bug|broken|regress|исправ|почин|ошибк/.test(words)) return "fix";
  if (/\btests?\b|\bchecks?\b|\bgate\b|drill|verify|smoke|\be2e\b|audit|провер|тест/.test(words)) return "check";
  if (/readme|docs?\b|changelog|guide|документ/.test(words)) return "docs";
  if (/refactor|cleanup|rename|split|рефактор/.test(words)) return "refactor";
  if (/research|investigat|spike|исследов/.test(words)) return "research";
  if (/chore|bump|deps|bookkeeping|release/.test(words)) return "chore";
  return "feature";
}

/** The tasks a waiting task names in its writer-stage reason: «waiting for depends_on: a,b» or «waiting for x (thread …)». */
function waitsFor(reason: string | null): string[] {
  const depends = /waiting for depends_on: ([^\s(]+)/.exec(reason ?? "");
  if (depends) return depends[1]!.split(",").filter(Boolean);
  const holder = /waiting for (\S+) \(thread/.exec(reason ?? "");
  return holder ? [holder[1]!] : [];
}

export function buildTaskBoard(db: LanePilotDatabase, input: { projectId?: string | null; doneSince: number; limit?: number; runIds?: readonly string[] }): BoardItem[] {
  const limit = input.limit ?? 400;
  const runs = input.runIds?.length ? `AND a.run_id IN (${input.runIds.map(() => "?").join(",")})` : "";
  const scope = `${input.projectId ? "AND r.project_id=?" : ""} ${runs}`;
  const args = [...(input.projectId ? [input.projectId] : []), ...(input.runIds?.length ? input.runIds : [])];
  const rawTasks = db.prepare(`SELECT a.id AS attempt_id, a.run_id, a.task_id, a.state, a.reason, a.thread_id, a.attempt_no, a.updated_at, a.created_at,
      t.contract_json, r.project_id, r.pm_thread_id, r.closed_at, r.objective
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    LEFT JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE a.attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)
      AND ((a.state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested') AND r.closed_at IS NULL) OR a.updated_at>=?) ${scope}
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt c JOIN lane_pilot_run rc ON rc.id=c.run_id
        WHERE rc.project_id=r.project_id AND c.created_at>=a.created_at AND substr(c.task_id,1,length(a.task_id)+1)=a.task_id || '.')
    ORDER BY a.updated_at DESC LIMIT ?`).all(input.doneSince, ...args, limit) as Array<{
    attempt_id: string; run_id: string; task_id: string; state: string; reason: string | null; thread_id: string | null; attempt_no: number;
    updated_at: number; created_at: number; contract_json: string | null; project_id: string; pm_thread_id: string | null; closed_at: number | null; objective: string | null;
  }>;
  // A version the PM replaced is not on the board: the check above finds only `x.3.1`, and PMs number redos `x.4`, so a blocked
  // `vf-s1-xp.3` stayed «blocked» next to its accepted `vf-s1-xp.4` (Vampirism Fire, 2026-10-23).
  const laterOfFamily = db.prepare(`SELECT c.task_id AS taskId FROM lane_pilot_attempt c JOIN lane_pilot_run rc ON rc.id=c.run_id
    WHERE rc.project_id=? AND c.created_at>? AND c.task_id<>? AND c.task_id LIKE ? ESCAPE '\\'`);
  const tasks = rawTasks.filter((row) => {
    const family = taskFamily(row.task_id);
    const like = `${family.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    return !(laterOfFamily.all(row.project_id, row.created_at, row.task_id, like) as Array<{ taskId: string }>).some((other) => taskFamily(other.taskId) === family);
  });
  const now = Date.now();
  const stagesOf = db.prepare("SELECT stage_id, state, reason, model, updated_at FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=?");
  const items: BoardItem[] = tasks.map((row) => {
    const stages = stagesOf.all(row.run_id, row.task_id) as Array<{ stage_id: string; state: string; reason: string | null; model: string | null; updated_at: number }>;
    const writer = stages.find((stage) => stage.stage_id === "writer-agent");
    const checking = stages.find((stage) => CHECK_STAGES.has(stage.stage_id) && stage.state === "running");
    const planning = stages.find((stage) => PLAN_STAGES.has(stage.stage_id) && stage.state === "running");
    const contract = parse(row.contract_json);
    const techTitle = text(contract.title) ?? row.task_id;
    const display = text(contract.display_title);
    let column: BoardColumn;
    let phase: BoardPhase;
    let at: { stage_id: string; model: string | null; updated_at: number } | undefined;
    let detail: string | null = null;
    let waitingFor: string[] = [];
    const open = row.closed_at === null;
    if (row.state === "accepted" || row.state === "canceled") { column = "done"; phase = row.state; }
    else if (open && row.state === "queued") {
      column = "queued";
      waitingFor = writer?.state === "pending" ? waitsFor(writer.reason) : [];
      phase = planning ? "planning" : waitingFor.length ? "waiting" : "queued";
      at = planning;
      detail = waitingFor.length ? null : clip(writer?.state === "pending" ? writer.reason : null, 160);
    } else if (open && LIVE.has(row.state) && writer?.state === "pending" && waitsFor(writer.reason).length) {
      // The attempt started, but its writer waits for the files or folder another task holds (a mainfix, a sibling of the area).
      column = "queued"; phase = "waiting"; waitingFor = waitsFor(writer.reason);
    } else if (open && LIVE.has(row.state)) {
      if (checking || writer?.state === "passed") { column = "checking"; phase = "checking"; at = checking; }
      else { column = "running"; phase = "writing"; at = writer; }
    } else if (open && row.state !== "blocked" && now - row.updated_at < RETRY_GRACE_MS) { column = "running"; phase = "retrying"; detail = clip(row.reason ?? row.state, 160); }
    else {
      // Blocked; a failed attempt no retry followed; or a task its run was closed under.
      column = "blocked";
      phase = !open ? "closed" : row.state === "blocked" ? "blocked" : "stuck";
      detail = clip(row.reason);
    }
    const kindValue = text(contract.kind) as TaskKind | null;
    return {
      kind: "task", key: `task:${row.run_id}:${row.task_id}`, runId: row.run_id, taskId: row.task_id,
      title: display ?? techTitle, techTitle: display ? techTitle : null,
      taskKind: kindValue && KINDS.has(kindValue) ? kindValue : inferTaskKind(row.task_id, techTitle),
      area: text(contract.area), objective: clip(row.objective, 160), projectId: row.project_id, pmThreadId: row.pm_thread_id,
      column, state: row.state, phase, stage: at?.stage_id ?? null, model: at?.model ?? null, since: at ? at.updated_at : null,
      waitingFor, detail, attemptNo: row.attempt_no, threadId: row.thread_id, attemptId: row.attempt_id, updatedAt: row.updated_at,
    };
  });
  // Workflow runs the owner or a PM started (insights, research, reels...); a task's own pipeline run is part of the task above.
  // A board narrowed to some task runs has none.
  const flows = input.runIds?.length ? [] : db.prepare(`SELECT id, workflow_id, definition_json, project_id, status, reason, created_at, updated_at FROM lane_pilot_wf_run
    WHERE depth=0 AND link_task_id IS NULL AND (status NOT IN ('succeeded','canceled') OR updated_at>=?) ${input.projectId ? "AND project_id=?" : ""}
    ORDER BY updated_at DESC LIMIT ?`).all(input.doneSince, ...(input.projectId ? [input.projectId] : []), limit) as Array<{
    id: string; workflow_id: string; definition_json: string; project_id: string | null; status: string; reason: string | null; created_at: number; updated_at: number;
  }>;
  const currentStep = db.prepare("SELECT node_id FROM lane_pilot_wf_step WHERE run_id=? AND state IN ('running','waiting') ORDER BY rowid DESC LIMIT 1");
  for (const row of flows) {
    const column: BoardColumn = row.status === "running" ? "running" : row.status === "waiting" ? "queued"
      : row.status === "succeeded" || row.status === "canceled" ? "done" : "blocked";
    const definition = parse(row.definition_json);
    const step = column === "running" || column === "queued" ? (currentStep.get(row.id) as { node_id: string } | undefined)?.node_id ?? null : null;
    items.push({
      kind: "workflow", key: `workflow:${row.id}`, runId: row.id, taskId: null, title: nameOf(definition.name ?? definition.title, row.workflow_id), techTitle: row.workflow_id,
      taskKind: null, area: null, objective: null, projectId: row.project_id, pmThreadId: null, column, state: row.status, phase: "chain",
      stage: step, model: null, since: step ? row.updated_at : null, waitingFor: [], detail: column === "blocked" ? clip(row.reason) : null,
      attemptNo: 0, threadId: null, attemptId: null, updatedAt: row.updated_at,
    });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export type CardThread = { id: string; role: string; title: string | null; status: string | null; children: CardThread[] };
export type TaskCard = {
  kind: "task" | "workflow"; title: string; techTitle: string | null; taskKind: TaskKind | null; area: string | null; objective: string | null;
  pmThreadId: string | null; id: string; projectId: string | null; state: string; reason: string | null;
  contract: { objective: string | null; acceptance: string[]; ownsPaths: string[]; expectedOutputs: string[]; dependsOn: string[]; checks: string[] } | null;
  plan: string | null;
  stages: Array<{ id: string; state: string; reason: string | null; threadId: string | null; model: string | null; updatedAt: number }>;
  attempts: Array<{ id: string; no: number; state: string; reason: string | null; threadId: string | null; createdAt: number; updatedAt: number }>;
  threads: CardThread | null;
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** What a card shows from the database; the thread tree is filled by the caller, which can ask BB for child threads. */
export function readTaskCard(db: LanePilotDatabase, input: { runId: string; taskId: string | null }): (TaskCard & { roots: Array<{ id: string; role: string }> }) | null {
  if (input.taskId === null) {
    const run = db.prepare("SELECT id, workflow_id, definition_json, project_id, status, reason FROM lane_pilot_wf_run WHERE id=?").get(input.runId) as
      { id: string; workflow_id: string; definition_json: string; project_id: string | null; status: string; reason: string | null } | undefined;
    if (!run) return null;
    const steps = db.prepare("SELECT step_key, node_id, state, error, receipt_json, rowid FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid").all(run.id) as
      Array<{ step_key: string; node_id: string; state: string; error: string | null; receipt_json: string | null }>;
    const threadOf = (json: string | null) => { const found = /"threadId"\s*:\s*"(thr_[A-Za-z0-9]+)"/.exec(json ?? ""); return found?.[1] ?? null; };
    const stageRows = steps.map((step) => ({ id: step.node_id, state: step.state, reason: clip(step.error), threadId: threadOf(step.receipt_json), model: null, updatedAt: 0 }));
    return {
      kind: "workflow", title: nameOf(parse(run.definition_json).name, run.workflow_id), techTitle: run.workflow_id, taskKind: null, area: null, objective: null,
      id: run.workflow_id, projectId: run.project_id, state: run.status, reason: clip(run.reason, 1000),
      contract: null, plan: null, stages: stageRows, attempts: [], threads: null, pmThreadId: null,
      roots: stageRows.filter((row) => row.threadId).map((row) => ({ id: row.threadId!, role: row.id })),
    };
  }
  const run = db.prepare("SELECT project_id, pm_thread_id, objective FROM lane_pilot_run WHERE id=?").get(input.runId) as { project_id: string; pm_thread_id: string | null; objective: string | null } | undefined;
  const task = db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id=?").get(input.taskId) as { contract_json: string } | undefined;
  if (!run || !task) return null;
  let contract: Record<string, unknown> = {};
  try { contract = JSON.parse(task.contract_json) as Record<string, unknown>; } catch { /* a broken contract still shows its stages */ }
  const plan = db.prepare("SELECT plan FROM lane_pilot_task_plan WHERE task_id=?").get(input.taskId) as { plan?: string } | undefined;
  const stages = (db.prepare("SELECT stage_id, state, reason, thread_id, model, updated_at FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? ORDER BY updated_at").all(input.runId, input.taskId) as
    Array<{ stage_id: string; state: string; reason: string | null; thread_id: string | null; model: string | null; updated_at: number }>)
    .map((row) => ({ id: row.stage_id, state: row.state, reason: clip(row.reason, 600), threadId: row.thread_id, model: row.model, updatedAt: row.updated_at }))
    // The pipeline's order (pm-read … acceptance-receipt), not the order of their last change: a reopened check is not «after» the writer.
    .sort((a, b) => stageOrder(a.id) - stageOrder(b.id));
  const attempts = (db.prepare("SELECT id, attempt_no, state, reason, thread_id, created_at, updated_at FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY attempt_no").all(input.runId, input.taskId) as
    Array<{ id: string; attempt_no: number; state: string; reason: string | null; thread_id: string | null; created_at: number; updated_at: number }>)
    .map((row) => ({ id: row.id, no: row.attempt_no, state: row.state, reason: clip(row.reason, 600), threadId: row.thread_id, createdAt: row.created_at, updatedAt: row.updated_at }));
  const last = attempts.at(-1);
  const roots = new Map<string, string>();
  for (const attempt of attempts) if (attempt.threadId) roots.set(attempt.threadId, `writer#${attempt.no}`);
  for (const stage of stages) if (stage.threadId && !roots.has(stage.threadId)) roots.set(stage.threadId, stage.id);
  const checks = Array.isArray(contract.verification) ? (contract.verification as Array<{ command?: unknown }>).map((check) => check.command).filter((item): item is string => typeof item === "string") : [];
  return {
    kind: "task", ...(() => {
      const tech = text(contract.title) ?? input.taskId;
      const display = text(contract.display_title);
      const kindValue = text(contract.kind) as TaskKind | null;
      return { title: display ?? tech, techTitle: display ? tech : null, taskKind: kindValue && KINDS.has(kindValue) ? kindValue : inferTaskKind(input.taskId!, tech) };
    })(),
    area: text(contract.area), objective: clip(run.objective, 400), id: input.taskId, projectId: run.project_id,
    state: last?.state ?? "queued", reason: last?.reason ?? null,
    contract: { objective: typeof contract.objective === "string" ? contract.objective : null, acceptance: strings(contract.acceptance), ownsPaths: strings(contract.owns_paths),
      expectedOutputs: strings(contract.expected_outputs), dependsOn: strings(contract.depends_on), checks },
    plan: plan?.plan ?? null, stages, attempts, threads: null, pmThreadId: run.pm_thread_id,
    roots: [...roots].map(([id, role]) => ({ id, role })),
  };
}
