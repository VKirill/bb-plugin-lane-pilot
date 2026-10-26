import type { PrototypeConfig, TaskV2 } from "../../contracts";
import type { ServerCore, Services } from "../../core/server";
import { taskFamily } from "../../runs";
import { deleteStageReceipt, getAttempt, getTaskGitBase, listAttemptsForTask, listStageReceipts, reviveCanceledAttempt } from "../../storage";
import { isMainfixTask } from "../../tasks";
import { recordStage } from "../../runs/server";

/**
 * A replan used to cancel the queue and send every task again as `<id>.N`: a new task, a new attempt row and a new pm-read and plan critique
 * for work that had not started (Vampirism Fire: five times; 224 canceled attempts in 14 days, 51 «canceled while its writer was starting»).
 * The same contract and plan sent again after its queued attempt was canceled gets that task and attempt back instead. Only a settled case
 * qualifies: the writer never had a thread or a workspace, and the dispatch stages are over (the ownership base is taken, or the task's
 * start loop is still waiting); stages this instance still runs are left to end first, and the task is then sent as before, under a new id.
 */
export function reviveCanceledTask(deps: { ctx: ServerCore; services: Services; live: ReadonlySet<string>; sameWork: (taskId: string, contract: unknown) => boolean },
  args: { projectId: string; runId: string; requestedId: string; pmThreadId: string; config: PrototypeConfig; task: TaskV2; plan: string }): Record<string, unknown> | null {
  const { db, refreshRun } = deps.ctx;
  const family = taskFamily(args.requestedId);
  const row = (db.prepare("SELECT id, contract_json FROM lane_pilot_task WHERE run_id=? AND kind='bb' ORDER BY created_at DESC, rowid DESC").all(args.runId) as Array<{ id: string; contract_json: string }>)
    .find((item) => !isMainfixTask(item.id) && taskFamily(item.id) === family);
  if (!row) return null;
  let stored: unknown;
  try { stored = JSON.parse(row.contract_json); } catch { return null; }
  if (!deps.sameWork(row.id, stored)) return null;
  const latest = listAttemptsForTask(db, args.runId, row.id).at(-1);
  const attempt = latest ? getAttempt(db, latest.id) : null;
  if (!attempt || attempt.state !== "canceled" || attempt.thread_id || attempt.workspace_path || deps.live.has(attempt.id)) return null;
  const key = `${args.runId}:${row.id}`;
  const looping = deps.services.activeWriterTasks.has(key);
  if (!looping && !getTaskGitBase(db, row.id)) return null;
  if (!reviveCanceledAttempt(db, attempt.id, `sent again unchanged after its cancel; the attempt ${attempt.id} was reused`)) return null;
  // Canceled receipts cannot leave their state: the writer stages start again from nothing, as a new attempt would have them.
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
    if (listStageReceipts(db, args.runId, row.id).some((receipt) => receipt.stageId === stageId)) deleteStageReceipt(db, args.runId, row.id, stageId);
    recordStage(db, { runId: args.runId, taskId: row.id, stageId, state: "pending", input: args.plan });
  }
  db.prepare("UPDATE lane_pilot_task SET closed_words=NULL WHERE id=?").run(row.id);
  refreshRun(args.runId);
  // A start loop still waiting goes on with the revived attempt by itself; one that is gone is started again (it is idempotent per task).
  if (!looping) deps.services.startWriterTask({ projectId: args.projectId, runId: args.runId, taskId: row.id, firstAttemptId: attempt.id, pmThreadId: args.pmThreadId, config: args.config, task: { ...args.task, id: row.id }, plan: args.plan });
  return { runId: args.runId, taskId: row.id, attemptId: attempt.id, writerThreadId: null, state: "queued", reused: true, stages: listStageReceipts(db, args.runId, row.id),
    note: "This task was canceled before its writer started and sent again unchanged: it is the same task and attempt, nothing new was created. To replan queued tasks, hold them (lane_pilot_queue hold) instead of canceling and sending again." };
}
