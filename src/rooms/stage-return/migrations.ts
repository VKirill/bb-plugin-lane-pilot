/**
 * Return to an earlier stage with added context (SMA atlas delta D0-2: the non-linear graph, «из 4 вернуться в 1, из 5 во 2»). One table,
 * spread at the END of `migrations` in storage/database.ts.
 *
 * lane_pilot_stage_return: one row per return. `to_stage` is where the person sent the task (discussion, planning, writer), `from_stage` the
 * earliest task stage that is stale because of it, `reused_json` / `stale_json` the receipts kept and the receipts reset (with why), `note` the
 * context the person added (it goes into the PM's message and into the writer's next brief), `paused` what was done to the running attempt,
 * `state` how far the return got: requested, then restarted (the writer works again), handed_to_pm (the PM has the note and the stale stages) or
 * failed / refused with `detail` saying why. A note is never edited or deleted: it is the record of the intervention.
 */
export const stageReturnMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_stage_return (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT,
    to_stage TEXT NOT NULL CHECK(to_stage IN ('discussion','planning','writer')),
    from_stage TEXT,
    by TEXT NOT NULL,
    note TEXT NOT NULL,
    reused_json TEXT NOT NULL DEFAULT '[]',
    stale_json TEXT NOT NULL DEFAULT '[]',
    paused TEXT,
    state TEXT NOT NULL CHECK(state IN ('requested','restarted','handed_to_pm','failed')),
    detail TEXT,
    done_at INTEGER
  )`,
  `CREATE INDEX lane_pilot_stage_return_task ON lane_pilot_stage_return(run_id, task_id, at)`,
];
