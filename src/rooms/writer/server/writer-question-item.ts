import { tableExists, type OwnerItemSweep } from "../../owner-waiting";

const WRITER_QUESTION_PREFIX = "writer-question:";

/** The owner-item key of a writer's question left to the owner: `writer-question:<run>:<task>`. */
export const writerQuestionKey = (runId: string, taskId: string) => `${WRITER_QUESTION_PREFIX}${runId}:${taskId}`;

/** The task moved on (a newer attempt, or the blocked one left `blocked`): the question's row goes. */
export const writerQuestionSweep: OwnerItemSweep = (db, item) => {
  if (!item.key.startsWith(WRITER_QUESTION_PREFIX) || !tableExists(db, "lane_pilot_attempt")) return null;
  const [, runId, ...task] = item.key.split(":");
  const latest = db.prepare("SELECT state, created_at FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC, attempt_no DESC LIMIT 1").get(runId, task.join(":")) as { state: string; created_at: number } | undefined;
  return latest && (latest.created_at > item.created_at || latest.state !== "blocked") ? "janitor:task moved on" : null;
};
