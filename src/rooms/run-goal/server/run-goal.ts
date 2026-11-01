import { getRun } from "../../storage";
import { scheduleIsolated, type ServerCore, type Services } from "../../core/server";
import { closeOwnerItem, postOwnerItem } from "../../owner-waiting";
import { goalFailedText, goalVerdict, runReady, type TaskState } from "../logic";
import { getRunGoal, saveRunGoal, type RunGoalRecord } from "../store";

/**
 * The run-goal service (SMA atlas D2-3). A sweep every 20 minutes finds the runs of the last week that are done (every task accepted or
 * canceled, two accepted at least) and have no verdict yet, and checks each once: the regression pass runs every accepted task's checks
 * together on the project's current main (mode full: a slow check is not dropped). A failed goal is a row on the owner's list with
 * the red checks and the commit bisect named (the run is done: its PM chat is not woken for a fact, 2026-10-31); a red check broken by work outside the run, or rewritten on purpose by a later task of the
 * run, is set aside (logic.ts goalVerdict) and stays in the regression list; the verdict is kept per run.
 */
const WEEK = 7 * 86_400_000;

export function createRunGoal(ctx: ServerCore, services: Services) {
  const { db, bb } = ctx;

  function taskStates(runId: string): TaskState[] {
    return (db.prepare(`SELECT t.id AS task_id, (SELECT a.state FROM lane_pilot_attempt a WHERE a.run_id=t.run_id AND a.task_id=t.id ORDER BY a.attempt_no DESC, a.updated_at DESC LIMIT 1) AS state
      FROM lane_pilot_task t WHERE t.run_id=?`).all(runId) as Array<{ task_id: string; state: string | null }>).map((row) => ({ taskId: row.task_id, state: row.state ?? "queued" }));
  }

  async function check(runId: string): Promise<RunGoalRecord> {
    const run = getRun(db, runId);
    if (!run) throw new Error(`no run ${runId}`);
    const tasks = taskStates(runId);
    const result = await services.regression.run({ projectId: run.project_id, runId, force: true, mode: "full" });
    const pass = result.projects[0] ?? { skipped: "the regression pass returned nothing", tasks: [], findings: [], head: null };
    const verdict = goalVerdict(pass, tasks.map((task) => task.taskId));
    const record: RunGoalRecord = { runId, projectId: run.project_id, state: verdict.state, tasks: tasks.filter((task) => task.state === "accepted").length, headSha: pass.head ?? null, red: verdict.red, detail: verdict.detail, at: Date.now(), coverage: verdict.coverage };
    saveRunGoal(db, record);
    if (verdict.state === "failed") {
      postOwnerItem(db as never, { key: `run-goal:${runId}`, source: "run-goal", kind: "goal_failed", projectId: run.project_id, wake: false,
        what: `После слияния всех задач в main упало проверок: ${verdict.red.length}`, why: goalFailedText(runId, verdict.red), evidence: [{ kind: "run", ref: runId }] });
    } else closeOwnerItem(db as never, `run-goal:${runId}`, `run-goal:${verdict.state}`); // the fix landed, or the run has nothing red: the row leaves the list (SWE-2 F-006)
    // A partial or inconclusive verdict is not a pass either; the log and the verdict say what did not run.
    ctx.log(`run-goal: ${runId} ${verdict.state}${verdict.red.length ? ` (${verdict.red.length} red)` : ""}${verdict.detail ? `: ${verdict.detail}` : ""}`);
    return record;
  }

  /** The runs that are done and have no verdict, checked one after another; returns the verdicts written. */
  async function sweep(now = Date.now(), signal?: AbortSignal): Promise<RunGoalRecord[]> {
    // A `failed` record is checked again once a later run of the project closed after it: that is when a fix could have landed, and
    // the red row then leaves the list by itself instead of waiting for a manual check or its seven-day term (SWE-2 F-006 remainder).
    // A run without a record is checked once. A `skipped` record whose detail is our own failure note means the check itself
    // could not run (a crashed regression call): it is retried on the next sweep. A `skipped` verdict of the goal logic
    // ("nothing to check") is final and is not retried.
    const runs = db.prepare(`SELECT r.id FROM lane_pilot_run r WHERE r.updated_at >= ?
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_run_goal g WHERE g.run_id = r.id AND NOT (g.state = 'skipped' AND g.detail LIKE 'the check failed:%')
        AND NOT (g.state = 'failed' AND EXISTS (SELECT 1 FROM lane_pilot_run r2 WHERE r2.project_id = r.project_id AND r2.id <> r.id AND r2.closed_at IS NOT NULL AND r2.closed_at > g.at)))
      ORDER BY r.updated_at`)
      .all(now - WEEK) as Array<{ id: string }>;
    const out: RunGoalRecord[] = [];
    for (const { id } of runs) {
      if (signal?.aborted || ctx.isDisposed()) break;
      if (!runReady(taskStates(id))) continue;
      out.push(await check(id).catch((cause: unknown) => {
        ctx.log(`run-goal: ${id} not checked: ${cause instanceof Error ? cause.message : String(cause)}`);
        const record: RunGoalRecord = { runId: id, projectId: getRun(db, id)?.project_id ?? "", state: "skipped", tasks: 0, headSha: null, red: [], detail: `the check failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 500), at: Date.now(), coverage: { planned: 0, ran: 0, skipped: 0 } };
        saveRunGoal(db, record);
        return record;
      }));
    }
    return out;
  }

  return { runGoal: { check, sweep, status: (runId: string) => getRunGoal(db, runId) } };
}
export type RunGoalApi = ReturnType<typeof createRunGoal>["runGoal"];

export function mountRunGoal(ctx: ServerCore, api: RunGoalApi): void {
  scheduleIsolated(ctx.bb, "run-goal-sweep", "*/20 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.sweep(Date.now(), signal).catch((cause: unknown) => ctx.log(`run-goal sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 2 * 3_600_000 });
}
