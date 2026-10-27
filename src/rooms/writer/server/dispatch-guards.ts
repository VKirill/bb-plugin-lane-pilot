import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import { batchShapeAdvice, topicHold, topicLoop, topicLoopMessage } from "../../tasks";
import type { LoopTask, OpenShape } from "../../tasks";
import { taskFamily } from "../../runs";
import { getTask, listOpenAttempts } from "../../storage";
import type { LanePilotDatabase } from "../../storage";
import type { Services } from "../../core/server";

/** The shape the loop stopper reads of a task contract; null for a contract that does not parse. */
export function loopTaskOf(id: string, createdAt: number, contract: unknown, attempts: LoopTask["attempts"]): LoopTask | null {
  const parsed = taskV2Schema.safeParse(contract);
  if (!parsed.success) return null;
  const task = parsed.data;
  const files = [...task.owns_paths, ...task.expected_outputs];
  const commands = task.verification.map((check) => check.command);
  return { id, createdAt, kind: task.kind, area: task.area, title: task.title, objective: task.objective, files, commands, text: [task.title, task.objective, ...files, ...commands].join(" "), attempts };
}

/**
 * The refusal for a task that would be another try on a topic of its run (see tasks/topic-loop.ts), or null. Reads the run's
 * tasks and their attempts from the database; see `topicLoopStop` for what the refusal does.
 */
export async function topicLoopGuard(db: LanePilotDatabase, runId: string, task: TaskV2, opts: { wall?: Services["wall"]; projectId?: string; pmThreadId?: string; now?: number } = {}): Promise<string | null> {
  const attempts = new Map<string, LoopTask["attempts"]>();
  for (const row of db.prepare("SELECT task_id, state, reason FROM lane_pilot_attempt WHERE run_id=? ORDER BY created_at").all(runId) as Array<{ task_id: string; state: string; reason: string | null }>) {
    attempts.set(row.task_id, [...(attempts.get(row.task_id) ?? []), { state: row.state, reason: row.reason }]);
  }
  const earlier: LoopTask[] = [];
  for (const row of db.prepare("SELECT id, contract_json, created_at FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{ id: string; contract_json: string; created_at: number }>) {
    let contract: unknown;
    try { contract = JSON.parse(row.contract_json); } catch { continue; }
    const loopTask = loopTaskOf(row.id, row.created_at, contract, attempts.get(row.id) ?? []);
    if (loopTask) earlier.push(loopTask);
  }
  const candidate = loopTaskOf(task.id, opts.now ?? Date.now(), task, []);
  return candidate ? topicLoopStop(opts.wall, runId, candidate, earlier, { projectId: opts.projectId, pmThreadId: opts.pmThreadId, contract: task }) : null;
}

/**
 * The first refusal of a topic also ends its loop: the wall (loop_exhausted) puts the big picture to three read-only hunters and writes the
 * backlog item. From then on the topic is closed to every task on it (whatever id, origin or mainfix) until an accepted fix closes the wall;
 * the hunt ending does not reopen it, and the one new try the topic allows is a decision tied to the incident (see `topicHold`). A closed
 * wall counts as the accepted research that ends the chase before it. Without a wall the PM is told to send the research task itself.
 */
export async function topicLoopStop(wall: Services["wall"] | undefined, runId: string, candidate: LoopTask, earlier: readonly LoopTask[], opts: { projectId?: string; pmThreadId?: string; contract?: unknown } = {}): Promise<string | null> {
  const hunts = wall?.loopTopics(runId) ?? [];
  const hold = topicHold(candidate, hunts, earlier);
  if (hold) return hold.allowed ? null : hold.why;
  const research: LoopTask[] = hunts.filter((hunt) => hunt.state === "closed").map((hunt) => ({ id: hunt.key, createdAt: hunt.updatedAt, kind: "research", title: hunt.topic, files: [], commands: [], text: hunt.topic, attempts: [{ state: "accepted", reason: null }] }));
  const found = topicLoop(candidate, [...earlier, ...research]);
  if (!found) return null;
  if (!wall || !opts.projectId) return topicLoopMessage(found);
  let hunt: string | undefined;
  if (!found.openAnalysis) {
    const tried = earlier.filter((other) => found.families.includes(taskFamily(other.id)));
    hunt = (await wall.loopExhausted({
      kind: "topic", id: `${runId}:${found.topic}:${found.key}:${hunts.filter((row) => row.topic === found.key).length}`, topic: found.key, projectId: opts.projectId, runId, pmThreadId: opts.pmThreadId ?? null,
      title: `run ${runId}: ${found.topic} ${found.key}, ${found.families.length} tasks in ${found.hours} h`,
      taskIds: found.families,
      facts: [`topic ${found.topic} ${found.key}: ${found.families.length} earlier tasks of the run (${found.families.join(", ")}) worked on it in ${found.hours} h and it is still patched, not solved`,
        `the fourth try, ${candidate.id} «${candidate.title}», was refused`, ...tried.slice(-6).map((other) => `${other.id} (${other.kind ?? "task"}): ${other.title}; attempts ${other.attempts.map((attempt) => attempt.state).join(", ") || "none"}`)],
      texts: [{ path: `TASK:${candidate.id}`, text: JSON.stringify(opts.contract ?? { id: candidate.id, title: candidate.title, files: candidate.files, commands: candidate.commands }) }],
      done: `the fourth task on ${found.key} (${candidate.id}) was refused; the hunters took the big picture instead and nothing was handed to the PM`,
    })).key;
  }
  return topicLoopMessage(found, hunt);
}

/** Advice on the queue the new task joins: the open tasks of its project it waits for, and the fix when three or more own one path. */
export function batchAdviceFor(db: LanePilotDatabase, projectId: string, task: TaskV2): string[] {
  const open: OpenShape[] = [];
  for (const row of listOpenAttempts(db)) {
    if (row.project_id !== projectId || row.task_id === task.id || open.some((other) => other.id === row.task_id)) continue;
    const parsed = taskV2Schema.safeParse(getTask(db, row.task_id)?.contract);
    if (parsed.success) open.push({ id: row.task_id, ownsPaths: parsed.data.owns_paths, dependsOn: parsed.data.depends_on });
  }
  return batchShapeAdvice({ id: task.id, ownsPaths: task.owns_paths, dependsOn: task.depends_on }, open);
}
