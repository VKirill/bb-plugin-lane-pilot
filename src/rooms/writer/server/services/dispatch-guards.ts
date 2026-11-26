import { taskV2Schema } from "../../../contracts";
import type { TaskV2 } from "../../../contracts";
import { batchShapeAdvice, checkoutOwnsOverlap, isMainfixTask, topicLoop, topicLoopMessage } from "../../../tasks";
import { medianTaskSize, recoveryState } from "../../../rollback/server";
import { hasOpenOwnerItem, postOwnerItem } from "../../../owner-waiting";
import type { LoopTask, OpenShape } from "../../../tasks";
import { taskFamily } from "@lane-pilot/contracts";
import { sha256Hex } from "@lane-pilot/kit";
import { checkoutBase, getRun, getTask, listAttemptsForTask, listOpenAttempts, taskBasePath, runAttemptOutcomeRows, listRunTaskRows } from "../../../storage";
import type { LanePilotDatabase } from "../../../storage";


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
export async function topicLoopGuard(db: LanePilotDatabase, runId: string, task: TaskV2, opts: { projectId?: string; pmThreadId?: string; now?: number; ownerSpokeAt?: number | null } = {}): Promise<string | null> {
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
  return candidate ? topicLoopStop(db, runId, candidate, earlier, { projectId: opts.projectId, pmThreadId: opts.pmThreadId, ownerSpokeAt: opts.ownerSpokeAt }) : null;
}

/**
 * After three tries on a topic fail in one run, the 4th try is stopped and escalated directly to the owner backlog
 * (failure class: task). Without a projectId/openAnalysis, falls back to the research-task guidance.
 */
export async function topicLoopStop(db: LanePilotDatabase, runId: string, candidate: LoopTask, earlier: readonly LoopTask[], opts: { projectId?: string; pmThreadId?: string; ownerSpokeAt?: number | null } = {}): Promise<string | null> {
  const context = { ownerSpokeAt: opts.ownerSpokeAt ?? null };
  const found = topicLoop(candidate, earlier, context);
  if (!found) return null;
  let incident: string | undefined;
  if (!found.openAnalysis && opts.projectId) {
    const key = `topic-loop:${runId}:${found.topic}:${sha256Hex(found.key).slice(0, 12)}`;
    incident = key;
    postOwnerItem(db, {
      key,
      source: "writer",
      kind: "topic_loop",
      reason: "blocked",
      projectId: opts.projectId,
      wake: false,
      what: `Три попытки на тему «${found.key}» не решили задачу`,
      why: `Класс сбоя: task. В прогоне ${runId} уже ${found.families.length} задач (${found.families.join(", ")}) работали над ${found.topic === "file" ? "файлом" : "тестом"} ${found.key} за ${found.hours} ч без решения; 4-я попытка ${candidate.id} остановлена для решения владельца.`,
      evidence: [{ kind: "run", ref: runId }, { kind: "task", ref: candidate.id }, ...found.families.slice(-3).map((fam) => ({ kind: "task" as const, ref: fam }))],
    });
  }
  return topicLoopMessage(found, incident);
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

export function canonicalJson(value:unknown): string {
  const sorted = (item:unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, sorted(v)]))
    : item;
  return JSON.stringify(sorted(value));
}
