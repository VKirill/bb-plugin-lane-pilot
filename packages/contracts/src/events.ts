/** Canonical workflow event names emitted across Lane Pilot rooms and graphs. */
export const LP_EVENTS = {
  THREAD_IDLE: "lp.thread.idle",
  PM_TURN_ENDED: "lp.pm.turn-ended",
  MEMORY_RECORD_COMMITTED: "lp.memory.record-committed",
  TASK_SETTLED: "lp.task.settled",
  WRITER_ANSWERED: "lp.writer.answered",
  PERMIT_REQUESTED: "lp.permit.requested",
  WRITER_PROCESS_EXITED: "lp.writer.process-exited",
  WRITER_WORK_HANDED_BACK: "lp.writer.work-handed-back",
  OWNER_ITEM_CREATED: "lp.owner.item-created",
  ATTEMPT_FINISHED: "lp.attempt.finished",
  ATTEMPT_MERGED: "lp.attempt.merged",
  WORKFLOW_RUN_FINISHED: "lp.workflow.run-finished",
  MODEL_CATALOG_CHANGED: "lp.models.catalog-changed",
  EVOLVE_THRESHOLD_CROSSED: "lp.evolve.threshold-crossed",
} as const;

export type LpEventName = (typeof LP_EVENTS)[keyof typeof LP_EVENTS] | (string & {});
