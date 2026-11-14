import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import { batchShapeAdvice, checkoutOwnsOverlap, isMainfixTask, topicHold, topicLoop, topicLoopMessage } from "../../tasks";
import { medianTaskSize } from "../../rollback/server";
import { recoveryState } from "../../rollback";
import { hasOpenOwnerItem } from "../../owner-waiting";
import type { LoopTask, OpenShape } from "../../tasks";
import { taskFamily } from "@lane-pilot/contracts";
import { checkoutBase, getRun, getTask, listAttemptsForTask, listOpenAttempts, taskBasePath, runAttemptOutcomeRows, listRunTaskRows } from "../../storage";
import type { LanePilotDatabase } from "../../storage";

import type { WallApi } from "../../wall/service";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  wall: WallApi;
}


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
export async function topicLoopGuard(db: LanePilotDatabase, runId: string, task: TaskV2, opts: { wall?: Services["wall"]; projectId?: string; pmThreadId?: string; now?: number; ownerSpokeAt?: number | null } = {}): Promise<string | null> {
  const attempts = new Map<string, LoopTask["attempts"]>();
  for (const row of runAttemptOutcomeRows(db, runId)) {
    attempts.set(row.task_id, [...(attempts.get(row.task_id) ?? []), { state: row.state, reason: row.reason, failureCode: row.failure_code }]);
  }
  const earlier: LoopTask[] = [];
  for (const row of listRunTaskRows(db, runId)) {
    let contract: unknown;
    try { contract = JSON.parse(row.contract_json); } catch { continue; }
    const loopTask = loopTaskOf(row.id, row.created_at, contract, attempts.get(row.id) ?? []);
    if (loopTask) earlier.push(loopTask);
  }
  const candidate = loopTaskOf(task.id, opts.now ?? Date.now(), task, []);
  return candidate ? topicLoopStop(opts.wall, runId, candidate, earlier, { projectId: opts.projectId, pmThreadId: opts.pmThreadId, contract: task, ownerSpokeAt: opts.ownerSpokeAt }) : null;
}

/**
 * The first refusal of a topic also ends its loop: the wall (loop_exhausted) puts the big picture to three read-only hunters and writes the
 * backlog item. From then on the topic is closed to every task on it (whatever id, origin or mainfix) until an accepted fix closes the wall;
 * the hunt ending does not reopen it, and the one new try the topic allows is a decision tied to the incident (see `topicHold`). A closed
 * wall counts as the accepted research that ends the chase before it. Without a wall the PM is told to send the research task itself.
 */
export async function topicLoopStop(wall: Services["wall"] | undefined, runId: string, candidate: LoopTask, earlier: readonly LoopTask[], opts: { projectId?: string; pmThreadId?: string; contract?: unknown; ownerSpokeAt?: number | null } = {}): Promise<string | null> {
  const hunts = wall?.loopTopics(runId) ?? [];
  const context = { ownerSpokeAt: opts.ownerSpokeAt ?? null };
  const hold = topicHold(candidate, hunts, earlier, context);
  if (hold) return hold.allowed ? null : hold.why;
  const research: LoopTask[] = hunts.filter((hunt) => hunt.state === "closed").map((hunt) => ({ id: hunt.key, createdAt: hunt.updatedAt, kind: "research", title: hunt.topic, files: [], commands: [], text: hunt.topic, attempts: [{ state: "accepted", reason: null }] }));
  const found = topicLoop(candidate, [...earlier, ...research], context);
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

/**
 * The refusal for a task family whose recovery is unfinished (SMA ac_recovery): a member's latest attempt is still
 * reconciling or its rollback failed — nothing retries or redispatches it until that clears. Null when all is clear.
 */
export function recoveryGuard(db: LanePilotDatabase, runId: string, taskId: string): string | null {
  const family = taskFamily(taskId);
  for (const row of listRunTaskRows(db, runId)) {
    if (isMainfixTask(row.id) || taskFamily(row.id) !== family) continue;
    const latest = listAttemptsForTask(db, runId, row.id).at(-1);
    if (!latest) continue;
    const state = recoveryState(db, latest.id);
    if (state === "reconciling" || state === "rollback_failed") {
      return `attempt ${latest.id} of ${row.id} is ${state}: recovery is unfinished — settle it first (let the reconcile finish, run the revert again, or ask the owner) before this family is dispatched again`;
    }
  }
  return null;
}

/**
 * The refusal for a task family whose baseline stop the owner has not settled (SMA ac_baseline_red): the stop posted a
 * baseline_red owner item; while it is open no writer starts on that base. Only with owner.words on — the person steps
 * are off otherwise. Null when there is no open item (his «yes» closed it).
 */
export function baselineRedGuard(db: LanePilotDatabase, runId: string, taskId: string, ownerWordsOn: boolean): string | null {
  if (!ownerWordsOn) return null;
  const key = `baseline-red:${runId}:${taskFamily(taskId)}`;
  return hasOpenOwnerItem(db as never, { key })
    ? `the owner is still deciding whether ${taskFamily(taskId)} may start on its red base (owner item ${key}): ask him with lane_pilot_ask_owner and send the task again once the item is answered`
    : null;
}

/** Advice on the queue the new task joins: the open tasks of its checkout it waits for, and the fix when three or more own one path. */
export function batchAdviceFor(db: LanePilotDatabase, projectId: string, runId: string, task: TaskV2): string[] {
  const base = checkoutBase(getRun(db, runId)?.writer_workspace_path ?? null, task.project_cwd, task.repo_scope === true);
  const open: OpenShape[] = [];
  for (const row of listOpenAttempts(db)) {
    if (row.project_id !== projectId || row.task_id === task.id || open.some((other) => other.id === row.task_id)) continue;
    const parsed = taskV2Schema.safeParse(getTask(db, row.task_id)?.contract);
    // Another repository of the BB project is another queue: the scheduler never holds a task for it (checkoutOwnsOverlap).
    if (!parsed.success || !checkoutOwnsOverlap(base, task.owns_paths, taskBasePath(db, row.run_id, row.task_id), parsed.data.owns_paths)) continue;
    open.push({ id: row.task_id, ownsPaths: parsed.data.owns_paths, dependsOn: parsed.data.depends_on });
  }
  return batchShapeAdvice({ id: task.id, ownsPaths: task.owns_paths, dependsOn: task.depends_on }, open, medianTaskSize(db, projectId));
}
