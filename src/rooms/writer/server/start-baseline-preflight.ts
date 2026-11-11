import { transitionAttempt } from "../../storage";
;
import { isMainfixTask } from "../../tasks";


import { type WriterTaskState } from "./start-task-state";
import { blockBeforeWriter } from "./start-prepare-run";

import { id } from "@lane-pilot/kit";


import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput } from "./start-task-state";

      // The baseline (src/rooms/baseline): the task's checks on the base before any writer is asked. «Already built» is told to the PM, or in
      // mode stop ends the task here with the evidence. A mainfix has its own preflight below; a folder without git has no base to run on.
      export const baselinePreflight = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<boolean> => {
        const { ctx, services } = deps;
        const { db } = ctx;
        if (!state.writerThreadId && !input.turnSent && !state.liveFolder && !isMainfixTask(input.task.id)) {
          const baseline = await services.baseline?.preflight({ projectId:input.projectId, runId:input.runId, taskId:input.taskId, attemptId: state.attemptId, pmThreadId:input.pmThreadId, config:state.freshConfig, task:state.freshTask });
          if (baseline?.alreadyDone) {
            ctx.log(`baseline ${input.taskId}: checks already pass on the base; closing accepted without a writer`);
            transitionAttempt(db, state.attemptId, "accepted");
            state.last = { status:"accepted", attemptId: state.attemptId, produced:[], verification:[], alreadyDone:baseline.alreadyDone };
            state.acceptedAttemptId = state.attemptId;
          } else if (baseline?.stop) { blockBeforeWriter(deps, state, input, baseline.stop); return false; }
        }
        return true;
      };
