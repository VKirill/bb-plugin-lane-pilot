import { failureClass } from "../runs";
import { statsEpochMs, STATS_EPOCH_SETTING } from "../storage";
import { taskStem } from "../tasks";

type Db = { prepare(sql:string):{ all(...args:unknown[]):unknown[] } };

export type CriticStats = {
  stage:string; runs:number; approved:number; blocked:number; skipped:number; blockShare:number | null;
  /** What became of a blocked task: a later dispatch of it was accepted, sent again without acceptance, or never sent again. */
  afterBlock:{ fixedAndAccepted:number; sentAgainNotAccepted:number; dropped:number };
  /** Approved tasks that later failed on a contract mistake the critic is there to catch. */
  missed:{ count:number; examples:Array<{ taskId:string; reason:string }> };
  /** Share of tasks accepted on their first attempt, reviewed by this critic or not. */
  firstTryAccepted:{ reviewed:{ tasks:number; share:number | null }; notReviewed:{ tasks:number; share:number | null } };
  /** How often the verdict predicted the outcome (accepted as-is, redone, or rolled back), overall and per model. */
  calibration:CriticCalibration;
};

/** A stage with at least this many labeled verdicts and under half of them right is a weak critic. */
export const CRITIC_CALIBRATION_MIN = 4;

export type CriticCalibration = {
  labeled:number; hits:number; accuracy:number | null; low:boolean;
  byModel:Array<{ model:string; labeled:number; hits:number; accuracy:number | null; low:boolean }>;
};

const share = (part:number, whole:number) => whole ? Math.round(100 * part / whole) : null;
const ROLLBACK = /rolled[_ -]?back|\breverted\b/i;
const score = (hits:number, labeled:number) => ({
  labeled, hits, accuracy: labeled ? Math.round(100 * hits / labeled) : null,
  low: labeled >= CRITIC_CALIBRATION_MIN && hits * 2 < labeled,
});
/** A failure the critic of this task could not have seen: the machine, the provider, or another task's dependency. */
const foreign = (state:string, reason:string | null) => {
  const cls = failureClass(state, reason);
  return cls === "infra" || cls === "provider" || cls === "harness" || cls === "limit" || cls === "budget"
    || cls === "merge" || cls === "dirty_base" || cls === "reassign" || cls === "judgment" || /depends_on/i.test(reason ?? "");
};
// A dependency that ended blocked is the PM's ordering, not something a critic of this task could see.
const criticCatches = (state:string, reason:string | null) => failureClass(state, reason) === "contract" && !/depends_on/i.test(reason ?? "");

/**
 * How much each critic is worth, from what is already recorded (Spotify measures the same of its judge: how often it
 * vetoes and how often a veto leads to a fix). Runs since `since` in one project.
 */
export function criticStats(db:Db, projectId:string, since:number, stages:readonly string[] = ["plan-critique", "code-critique", "specialist-review"]):CriticStats[] {
  // stats.epoch: runs and receipts before it stay in the tables but are not counted (owner 2026-10-30, default 2026-10-31).
  const epochRow = db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND key=?").all("*", STATS_EPOCH_SETTING) as Array<{ value:string }>;
  since = Math.max(since, statsEpochMs(epochRow[0]?.value));
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
  // true: the reviewed work was not accepted as-is (redo, contract miss, drop, rollback). false: accepted as-is. null: unlabeled.
  const problem = (taskId:string):boolean | null => {
    const rows = byTask.get(taskId) ?? [];
    const at = created.get(taskId) ?? 0;
    const later = tasks.filter((task) => task.id !== taskId && taskStem(task.id) === taskStem(taskId) && task.created_at > at);
    const rolled = rows.some((row) => ROLLBACK.test(row.reason ?? ""))
      || later.some((task) => (byTask.get(task.id) ?? []).some((row) => ROLLBACK.test(row.reason ?? "")));
    const contract = rows.some((row) => criticCatches(row.state, row.reason));
    const acceptedThis = rows.some((row) => row.state === "accepted");
    if (!acceptedThis && !contract && !rolled && !later.length && rows.length > 0 && rows.every((row) => foreign(row.state, row.reason))) return null;
    if (rolled || contract || later.length) return true;
    if (acceptedThis) return rows.some((row) => row.state !== "accepted" && !foreign(row.state, row.reason));
    return true;
  };

  return stages.map((stage) => {
    const receipts = db.prepare(`SELECT s.task_id, s.state, json_extract(s.result_json,'$.decision') decision,
      COALESCE(NULLIF(s.model,''), json_extract(s.result_json,'$.reviewer.model'), 'unknown') model
      FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id WHERE r.project_id=? AND s.stage_id=? AND s.updated_at>=?`)
      .all(projectId, stage, since) as Array<{ task_id:string; state:string; decision:string | null; model:string }>;
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
    const buckets = new Map<string, { labeled:number; hits:number }>();
    let labeled = 0, hits = 0;
    for (const row of receipts) {
      if (row.state !== "passed" && row.state !== "blocked") continue;
      const actual = problem(row.task_id);
      if (actual === null) continue;
      const saidBad = row.state === "blocked" || row.decision === "changes_requested";
      const hit = saidBad === actual;
      labeled++;
      if (hit) hits++;
      const bucket = buckets.get(row.model) ?? { labeled:0, hits:0 };
      bucket.labeled++;
      if (hit) bucket.hits++;
      buckets.set(row.model, bucket);
    }
    return {
      stage, runs, approved:approved.length, blocked:blocked.length, skipped:skipped.length, blockShare:share(blocked.length, runs),
      afterBlock, missed:{ count:misses.length, examples:misses.slice(0, 5) },
      firstTryAccepted:{
        reviewed:{ tasks:reviewed.length, share:share(reviewed.filter(firstAccepted).length, reviewed.length) },
        notReviewed:{ tasks:notReviewed.length, share:share(notReviewed.filter(firstAccepted).length, notReviewed.length) },
      },
      calibration:{
        ...score(hits, labeled),
        byModel:[...buckets.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([model, bucket]) => ({ model, ...score(bucket.hits, bucket.labeled) })),
      },
    };
  });
}
