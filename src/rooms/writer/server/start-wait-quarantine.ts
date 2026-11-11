import { listStageReceipts } from "../../storage";
import { pollPause } from "@lane-pilot/kit";
import type { TaskV2 } from "../../contracts";
import type { RegressionRecord } from "../../baseline";
import { quarantineFileSet } from "../../baseline";
import { quarantiningRegression } from "./start-quarantine";
import { recordStage } from "../../runs/server";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

/** W32 rank 8: a task that would touch the files of an open found regression waits for it to close — writing into
 * broken ground reruns the red check and blames the wrong task. No attempt is spent; the reason is in the stage receipt. */
export const waitForRegressionQuarantine = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, shouldStop?:()=>string|null) => {
  const { ctx, services } = deps;
  const { db } = ctx;
  // Narrowed 2026-11-02 (SelfyStudio cab-core-brace waited forever on editor.html it never touches): the files the
  // check can touch — sharedFiles plus the path literals of the command; the union of all changed files only when
  // neither is known (a check whose files cannot be read stays cautious).
  const changed = (taskId: string) => (services.rollback?.status(taskId).attempts ?? [])
    .filter((a) => a.state === "accepted").flatMap((a) => a.change?.changed.map((f) => f.path) ?? []);
  const filesOf = (open: RegressionRecord): string[] => quarantineFileSet(open, changed);
  let noted = "";
  for (;;) {
    if (ctx.isDisposed()) return;
    const stop = shouldStop?.();
    if (stop) return stop;
    const blocker = (() => {
      try {
        // fixes_regressions is optional in the contract: absent reads as no named rows (the cast keeps typecheck honest until the field ships).
        return quarantiningRegression(db, { projectId:input.projectId, runId:input.runId, taskId:input.taskId, ownsPaths:input.task.owns_paths,
          fixesRegressions:(input.task as TaskV2 & { fixes_regressions?: number[] }).fixes_regressions }, filesOf);
      } catch { return undefined; } // a test database without the baseline migrations quarantines nothing
    })();
    if (!blocker) return;
    if (noted !== `${blocker.id}`) {
      noted = `${blocker.id}`;
      const shared = filesOf(blocker).slice(0, 6).join(", ");
      const reason = `quarantine: regression #${blocker.id} of ${blocker.taskId} (check red since ${blocker.culpritTask ?? "unknown"}); if the change was meant: lane_pilot_regression {action:"settle", id:${blocker.id}, reason:"…"}; if it is a real break: fix it in a task that owns ${shared} with fixes_regressions:[${blocker.id}]`;
      ctx.log(`writer ${input.taskId} waits: ${reason}`);
      const stage = listStageReceipts(db,input.runId,input.taskId).find((row) => row.stageId === "writer-agent");
      if (!stage || stage.state === "pending") {
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan, reason });
      }
    }
    await new Promise((wake) => setTimeout(wake, pollPause(30_000)));
  }
};
