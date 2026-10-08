import { failureClass } from "../runs/failure-class";
import { taskStem } from "../tasks/task-stem";

type Db = { prepare(sql:string):{ all(...args:unknown[]):unknown[] } };

export type CriticStats = {
  stage:string; runs:number; approved:number; blocked:number; skipped:number; blockShare:number | null;
  /** What became of a blocked task: a later dispatch of it was accepted, sent again without acceptance, or never sent again. */
  afterBlock:{ fixedAndAccepted:number; sentAgainNotAccepted:number; dropped:number };
  /** Approved tasks that later failed on a contract mistake the critic is there to catch. */
  missed:{ count:number; examples:Array<{ taskId:string; reason:string }> };
  /** Share of tasks accepted on their first attempt, reviewed by this critic or not. */
  firstTryAccepted:{ reviewed:{ tasks:number; share:number | null }; notReviewed:{ tasks:number; share:number | null } };
};

const share = (part:number, whole:number) => whole ? Math.round(100 * part / whole) : null;
// A dependency that ended blocked is the PM's ordering, not something a critic of this task could see.
const criticCatches = (state:string, reason:string | null) => failureClass(state, reason) === "contract" && !/depends_on/i.test(reason ?? "");

/**
 * How much each critic is worth, from what is already recorded (Spotify measures the same of its judge: how often it
 * vetoes and how often a veto leads to a fix). Runs since `since` in one project.
 */
export function criticStats(db:Db, projectId:string, since:number, stages:readonly string[] = ["plan-critique", "code-critique", "specialist-review"]):CriticStats[] {
  const tasks = db.prepare(`SELECT t.id, t.created_at FROM lane_pilot_task t JOIN lane_pilot_run r ON r.id=t.run_id WHERE r.project_id=?`)
    .all(projectId) as Array<{ id:string; created_at:number }>;
  const attempts = db.prepare(`SELECT a.task_id, a.state, a.reason, a.created_at FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? ORDER BY a.created_at`).all(projectId) as Array<{ task_id:string; state:string; reason:string | null; created_at:number }>;
  const byTask = new Map<string, typeof attempts>();
  for (const row of attempts) byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), row]);
  const created = new Map(tasks.map((task) => [task.id, task.created_at]));
  const accepted = (taskId:string) => (byTask.get(taskId) ?? []).some((row) => row.state === "accepted");
  const firstAccepted = (taskId:string) => byTask.get(taskId)?.[0]?.state === "accepted";
  const finished = (taskId:string) => (byTask.get(taskId) ?? []).some((row) => ["accepted", "blocked", "canceled"].includes(row.state));

  return stages.map((stage) => {
    const receipts = db.prepare(`SELECT s.task_id, s.state, json_extract(s.result_json,'$.decision') decision FROM lane_pilot_stage_receipt s
      JOIN lane_pilot_run r ON r.id=s.run_id WHERE r.project_id=? AND s.stage_id=? AND s.updated_at>=?`)
      .all(projectId, stage, since) as Array<{ task_id:string; state:string; decision:string | null }>;
    const approved = receipts.filter((row) => row.state === "passed");
    const blocked = receipts.filter((row) => row.state === "blocked" || row.decision === "changes_requested");
    const skipped = receipts.filter((row) => row.state === "skipped");
    const afterBlock = { fixedAndAccepted:0, sentAgainNotAccepted:0, dropped:0 };
    for (const row of blocked) {
      const stem = taskStem(row.task_id), at = created.get(row.task_id) ?? 0;
      const later = tasks.filter((task) => task.id !== row.task_id && taskStem(task.id) === stem && task.created_at > at);
      if (later.some((task) => accepted(task.id))) afterBlock.fixedAndAccepted++;
      else if (later.length) afterBlock.sentAgainNotAccepted++;
      else afterBlock.dropped++;
    }
    const misses = approved.flatMap((row) => {
      const hit = (byTask.get(row.task_id) ?? []).find((attempt) => criticCatches(attempt.state, attempt.reason));
      return hit ? [{ taskId:row.task_id, reason:(hit.reason ?? "").slice(0, 160) }] : [];
    });
    const reviewed = approved.map((row) => row.task_id).filter(finished);
    const notReviewed = skipped.map((row) => row.task_id).filter(finished);
    const runs = approved.length + blocked.length;
    return {
      stage, runs, approved:approved.length, blocked:blocked.length, skipped:skipped.length, blockShare:share(blocked.length, runs),
      afterBlock, missed:{ count:misses.length, examples:misses.slice(0, 5) },
      firstTryAccepted:{
        reviewed:{ tasks:reviewed.length, share:share(reviewed.filter(firstAccepted).length, reviewed.length) },
        notReviewed:{ tasks:notReviewed.length, share:share(notReviewed.filter(firstAccepted).length, notReviewed.length) },
      },
    };
  });
}
