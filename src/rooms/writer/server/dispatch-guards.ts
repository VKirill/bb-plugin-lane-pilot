import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import { batchShapeAdvice, topicLoop, topicLoopMessage } from "../../tasks";
import type { LoopTask, OpenShape } from "../../tasks";
import { getTask, listOpenAttempts } from "../../storage";
import type { LanePilotDatabase } from "../../storage";

/** The shape the loop stopper reads of a task contract; null for a contract that does not parse. */
export function loopTaskOf(id: string, createdAt: number, contract: unknown, attempts: LoopTask["attempts"]): LoopTask | null {
  const parsed = taskV2Schema.safeParse(contract);
  if (!parsed.success) return null;
  const task = parsed.data;
  const files = [...task.owns_paths, ...task.expected_outputs];
  const commands = task.verification.map((check) => check.command);
  return { id, createdAt, kind: task.kind, area: task.area, title: task.title, files, commands, text: [task.title, task.objective, ...files, ...commands].join(" "), attempts };
}

/**
 * The refusal for a task that would be another try on a topic of its run (see tasks/topic-loop.ts), or null. Reads the run's
 * tasks and their attempts from the database; nothing is stored for it.
 */
export function topicLoopGuard(db: LanePilotDatabase, runId: string, task: TaskV2, now = Date.now()): string | null {
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
  const candidate = loopTaskOf(task.id, now, task, []);
  const found = candidate ? topicLoop(candidate, earlier) : null;
  return found ? topicLoopMessage(found) : null;
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
