import { pilotBlockedByOthers, pilotOf, pilotUnderWall, runTasks, type TaskWallRow } from "./pilot";
import { listWalls } from "../../wall";
import { DEPENDENCY_REDO_WAIT_MS, canceledLatestTaskIds, countChargedAttempts, getTask, latestRunTaskAttempt, latestRunTaskAttemptState, listRunTaskRows, listStageReceipts } from "../../storage";
import { pollPause } from "@lane-pilot/kit";
import { taskFamily } from "@lane-pilot/contracts";
import { isTaskSatisfied } from "../../runs/server";
import { recordStage } from "../../runs/server";
import { MAIN_ATTEMPT_LIMIT } from "../../contracts";
import { CANCELED_REDO_WAIT_MS } from "./start-wait-limits";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

/**
 * depends_on: the task starts only once every task it names is accepted (its work is in main). A blocked
 * dependency is usually fixed and sent again (`<id>.2`), which the name follows, so the task keeps waiting for it
 * up to six hours instead of failing at once and making the PM resend the whole chain (SelfyStudio 2026-10-04).
 * A canceled dependency, or a name no one dispatched, ends the wait at once.
 *
 * The owner's rule (ТЗ sma-parity 4д): a name resolves inside the task's own run, not across the project (an accepted «T1» of an
 * older run satisfied a new plan's «T1»); and depends_on is read from the stored contract on every poll, so a dependency the PM adds
 * while the task is queued counts (live zupo-cards-bot-flow, 2026-11: started 6 s after its first dependency, without the one added
 * at 22:09, on a base without that merge).
 */
/** The task's depends_on as stored now (lane_pilot_update_task may have changed it since dispatch), else as it was dispatched. */
export const storedDependsOn = (db: Parameters<typeof getTask>[0], taskId: string, dispatched: readonly string[] | undefined): string[] => {
  const stored = (getTask(db, taskId)?.contract as { depends_on?: unknown } | undefined)?.depends_on;
  return Array.isArray(stored) ? stored.filter((dep): dep is string => typeof dep === "string" && dep.length > 0) : [...(dispatched ?? [])];
};

export const waitForDependencies = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, shouldStop?:()=>string|null): Promise<string | null> => {
  const { ctx } = deps;
  const { bb, db } = ctx;
  // The pilot of this task's siblings (src/rooms/writer/server/pilot): waited for like a dependency, except that a canceled pilot holds no one.
  const waveTasks = runTasks(listRunTaskRows(db, input.runId), canceledLatestTaskIds(db, input.runId));
  let taskWalls: TaskWallRow[] = [];
  try { taskWalls = listWalls(db, { kind: "task", states: ["stopped","hunting","hunted","backlog"] }); }
  catch (cause) { ctx.log(`writer ${input.taskId}: the wall ladder is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const pilot = pilotOf(input.taskId, waveTasks);
  // A blocked pilot that nothing will redo soon (its own attempts are spent, or the wall ladder holds its family or a hunt runs on its
  // files), or one whose block is not about the task (the provider, the machine, Lane Pilot), holds no one: the wave goes on in its own
  // order, each task still serialised by owns_paths overlap. Only the PM's own depends_on keeps the 6-hour wait.
  const pilotGivenUp = (dep:string) => {
    const latest = latestRunTaskAttempt(db, input.runId, dep);
    return countChargedAttempts(db, input.runId, dep) >= MAIN_ATTEMPT_LIMIT || (latest !== null && pilotBlockedByOthers(latest.state, latest.reason))
      || pilotUnderWall(taskWalls, input.runId, taskFamily(dep), waveTasks.find((task) => task.id === dep)?.ownsPaths ?? []);
  };
  const own = () => storedDependsOn(db, input.taskId, input.task.depends_on);
  let noted = "";
  // A batch may dispatch the dependent before its dependency: each name gets two minutes to appear from when the wait first saw it.
  const firstSeen = new Map<string, number>();
  const blockedSince = new Map<string, number>();
  const released = new Set<string>();
  for (;;) {
    if (ctx.isDisposed()) return null;
    const stop = shouldStop?.();
    if (stop) return stop;
    const pending: string[] = [];
    const named = own();
    const depIds = [...new Set([...named, ...(pilot ? [pilot] : [])].filter((dep) => dep && dep !== input.taskId))];
    for (const dep of depIds) {
      const depState = latestRunTaskAttemptState(db, input.runId, dep);
      if (depState === "accepted") continue;
      if (!firstSeen.has(dep)) firstSeen.set(dep, Date.now());
      if (depState === null && Date.now() - firstSeen.get(dep)! > 120_000) return `depends_on ${dep}: no such task was dispatched in this run`;
      if (depState === "canceled" && dep === pilot && !named.includes(dep)) continue;
      if (depState === "blocked" || depState === "canceled") {
        // The PM verified this task by hand (lane_pilot_update_task satisfied:true): its dependents go on.
        if (await isTaskSatisfied(bb.storage.kv as never, input.projectId, dep)) continue;
        if (depState === "blocked" && dep === pilot && !named.includes(dep) && pilotGivenUp(dep)) {
          if (!released.has(dep)) { released.add(dep); ctx.log(`writer ${input.taskId} goes on: its pilot ${dep} ended blocked and nothing will redo it soon, or its block is not about the task`); }
          continue;
        }
        // A PM cancels mostly to send the task again with a fixed contract: magicseo T6 (2026-10-30) blocked 32 s after
        // T3.3 was canceled, while T3.4 went out within minutes. A canceled dependency waits CANCELED_REDO_WAIT_MS for it.
        blockedSince.set(dep, blockedSince.get(dep) ?? Date.now());
        if (depState === "canceled" && Date.now() - blockedSince.get(dep)! > CANCELED_REDO_WAIT_MS) return `depends_on ${dep}: that task ended canceled and was not sent again within ${CANCELED_REDO_WAIT_MS / 60_000} minutes`;
        if (depState === "blocked" && Date.now() - blockedSince.get(dep)! > DEPENDENCY_REDO_WAIT_MS) return `depends_on ${dep}: that task ended blocked and was not sent again within 6 hours`;
      } else blockedSince.delete(dep);
      pending.push(dep);
    }
    if (!pending.length) return null;
    // The text names which dependencies ended blocked; a restart of one of them changes it, so it is part of the key.
    const key = `${pending.join(",")}|${pending.filter((dep) => blockedSince.has(dep)).join(",")}`;
    if (noted !== key) {
      noted = key;
      ctx.log(`writer ${input.taskId} waits for depends_on ${pending.join(",")}`);
      const stage = listStageReceipts(db,input.runId,input.taskId).find((row) => row.stageId === "writer-agent");
      if (!stage || stage.state === "pending") {
        const redo = pending.filter((dep) => blockedSince.has(dep));
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
          reason:`${redo.length ? `waiting for depends_on: ${pending.join(",")} (${redo.join(", ")} ended blocked or canceled; starts once it is sent again and accepted)` : `waiting for depends_on: ${pending.join(",")}`}${pilot && pending.includes(pilot) ? ` (${pilot} is the pilot of its area: the siblings start once it is accepted)` : ""}` });
      }
    }
    await new Promise((wake) => setTimeout(wake, pollPause(10_000)));
  }
};
