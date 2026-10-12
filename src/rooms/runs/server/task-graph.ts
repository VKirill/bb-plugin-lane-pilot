import type { LanePilotDatabase } from "../../storage";

/** Why a task waits for another: its depends_on, the same files (owns_paths or area), one writer per folder without git, an unanswered question. */
export type TaskGraphEdgeKind = "depends" | "files" | "folder" | "question";
export type TaskGraphNode = { id: string; title: string; state: "running" | "waiting" | "queued" | "blocked"; threadId: string | null };
export type TaskGraph = { nodes: TaskGraphNode[]; edges: Array<{ from: string; to: string; kind: TaskGraphEdgeKind }> };

const WORKING = new Set(["spawn_requested", "spawn_unknown", "running", "cancel_requested", "validation_failed"]);
/** The writer-agent stage reason a waiting task records (src/rooms/writer/server/start.ts). */
const WAIT_FOR_TASK = /^waiting for (\S+) \(thread [^)]*\): (.*)$/;

const kindOfWait = (why: string): TaskGraphEdgeKind =>
  /question/.test(why) ? "question" : /one writer at a time|without git/.test(why) ? "folder" : "files";

/**
 * The run's tasks still to finish and what each waits for, so the PM chat can show what goes in parallel and what in turn.
 * A task's latest attempt decides its state; accepted and canceled tasks are left out, and a blocked one only appears when
 * a shown task waits for it (it holds the chain until it is sent again).
 */
export function buildTaskGraph(db: LanePilotDatabase, runId: string): TaskGraph {
  const rows = db.prepare(`SELECT t.id, t.contract_json, a.state, a.thread_id, s.state AS stage_state, s.reason AS stage_reason
    FROM lane_pilot_task t
    JOIN lane_pilot_attempt a ON a.run_id=t.run_id AND a.task_id=t.id
      AND a.attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)
    LEFT JOIN lane_pilot_stage_receipt s ON s.run_id=t.run_id AND s.task_id=t.id AND s.stage_id='writer-agent'
    WHERE t.run_id=? ORDER BY t.created_at`).all(runId) as Array<{
    id: string; contract_json: string; state: string; thread_id: string | null; stage_state: string | null; stage_reason: string | null;
  }>;
  const contract = (json: string): { title?: unknown; depends_on?: unknown } => { try { return JSON.parse(json) as never; } catch { return {}; } };
  const open = rows.filter((row) => row.state === "queued" || WORKING.has(row.state));
  const blocked = new Map(rows.filter((row) => row.state === "blocked").map((row) => [row.id, row]));
  // The same family rule as the writer's wait (latestTaskAttemptState): `P1`, `P1.2`, `P1.2.2` are one task sent again.
  const taskFamily = (id: string) => id.replace(/(\.\d+)+$/, "") || id;
  const byFamily = new Map<string, string>();
  for (const row of rows) byFamily.set(taskFamily(row.id), row.id);
  /** A depends_on name means its latest redispatch (`P1` → `P1.2`), as the writer's wait reads it. */
  const resolve = (name: string) => byFamily.get(taskFamily(name)) ?? name;

  const nodes = new Map<string, TaskGraphNode>();
  const edges = new Map<string, TaskGraph["edges"][number]>();
  const node = (row: (typeof rows)[number], state: TaskGraphNode["state"]) => {
    const title = contract(row.contract_json).title;
    nodes.set(row.id, { id: row.id, title: typeof title === "string" && title ? title : row.id, state, threadId: row.thread_id });
  };
  for (const row of open) {
    const waiting = row.state === "queued" && row.stage_state === "pending" && /^waiting/.test(row.stage_reason ?? "");
    node(row, WORKING.has(row.state) ? "running" : waiting ? "waiting" : "queued");
  }
  const edge = (from: string, to: string, kind: TaskGraphEdgeKind) => {
    if (from === to) return;
    const blocker = blocked.get(from);
    if (!nodes.has(from) && blocker) node(blocker, "blocked");
    if (nodes.has(from)) edges.set(`${from}>${to}`, { from, to, kind });
  };
  for (const row of open) {
    const deps = contract(row.contract_json).depends_on;
    for (const dep of Array.isArray(deps) ? deps.filter((item): item is string => typeof item === "string") : []) edge(resolve(dep), row.id, "depends");
    const wait = row.state === "queued" ? WAIT_FOR_TASK.exec(row.stage_reason ?? "") : null;
    if (wait && !edges.has(`${wait[1]}>${row.id}`)) edge(wait[1]!, row.id, kindOfWait(wait[2]!));
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
