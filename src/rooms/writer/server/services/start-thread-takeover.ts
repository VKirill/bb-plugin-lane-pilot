import { WRITER_PROVIDER_KEY, WRITER_MODEL_KEY } from "../../settings";
import { endSpawnFailure, getReasoningTrace } from "../../../storage";
import { REPLAY_CHECK_FAILED } from "../../../contracts";
import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { bestEffort } from "@lane-pilot/kit";
import type { DirtSnapshot } from "../../models/cli-outcome";
import { attemptFeedback } from "../../models/writer-brief-feedback";
import { stickyTurnPrompt } from "../../models/writer-task";
import { retargetTask } from "../../../tasks";


import { type WriterTaskState } from "./start-task-state";

import { listReturns, renderReturnNotes } from "../../../stage-return";


import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput } from "./start-task-state";
      /** Takes over an existing writer thread for this attempt; false leaves the attempt to a fresh spawn. */
      export const continueWith = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, writer:NonNullable<Awaited<ReturnType<StartWriterTaskDeps["sticky"]["hotWriter"]>>>, kind:"next-task"|"retry"|"merge", previousAttempt:string, keepDirt?:DirtSnapshot[]):Promise<boolean> => {
        const { ctx, sticky } = deps;
        const { bb, db } = ctx;
        const bound = retargetTask(state.freshTask,writer.workspacePath);
        // The third turn of this thread gets the digest of what it already did, not the raw trajectory.
        let feedback = previousAttempt;
        if (kind === "retry" && writer.turns >= 2) {
          const listed = await bestEffort(ctx.log, "writer attempt feedback events", listThreadEventsRaw(bb, { threadId: writer.threadId, order: "desc", limit: "50" }), null);
          feedback = attemptFeedback(writer.turns + 1, listed?.ok ? listed.events as Parameters<typeof attemptFeedback>[1] : [], previousAttempt);
        }
        const turnPrompt = (conflicts: string[]) => stickyTurnPrompt({
          kind, task: bound,
          previousAttempt: kind === "merge" && !previousAttempt.includes(REPLAY_CHECK_FAILED) ? "" : feedback,
          conflicts, liveFolder: state.liveFolder,
        });
        // A task a person sent back to an earlier stage with a note (src/rooms/stage-return) takes the note into the area writer's next-task turn.
        const returnNotes = kind === "next-task" ? renderReturnNotes(listReturns(db, input.runId, input.taskId)) : "";
        const turn = await sticky.continueInThread({ runId:input.runId, taskId:input.taskId, attemptId: state.attemptId, config:state.freshConfig, writer, kind, dirtBefore:keepDirt,
          prompt:returnNotes ? (conflicts) => `${turnPrompt(conflicts)}\n\n${returnNotes}` : turnPrompt });
        if (!turn.ok) {
          ctx.log(`writer ${input.taskId}: ${kind} in thread ${writer.threadId} not possible (${turn.reason}); a fresh writer starts`);
          // A half-bound attempt cannot take a fresh spawn: it ends as Lane Pilot's fault and the retry spawns.
          if (turn.bound) {
            state.last = { status:endSpawnFailure(db, state.attemptId, turn.reason), reason:turn.reason, attemptId: state.attemptId };
            state.halfBound = true;
          }
          return false;
        }
        state.writerThreadId = writer.threadId;
        const trace = getReasoningTrace(db, state.attemptId);
        state.writerSelection = trace ? { providerId:trace.providerId, model:trace.model, reasoningLevel:trace.effectiveReasoningLevel,
          serviceTier:trace.serviceTier, selectionSource:trace.selectionSource } : undefined;
        state.activeConfig = state.freshConfig;
        state.activeTask = bound;
        state.dirtBefore = turn.dirtBefore;
        state.baselineDirtBefore ??= [...turn.dirtBefore];
        state.baselineWorkspacePath ??= turn.workspacePath;
        state.executionPacketSha256 = null;
        return true;
      };
      // The area's writer from an earlier task of this run takes this one in its own thread, unless the writer setting now names
      // another provider or model: then this task gets a fresh writer on the current one (the spawn's own selection, below).
      export const handoffToHotWriter = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<void> => {
        const { sticky } = deps;
        if (!state.writerThreadId && input.task.area && !state.liveFolder) {
          const wanted = {
            providerId: typeof state.runSettings[WRITER_PROVIDER_KEY] === "string" ? state.runSettings[WRITER_PROVIDER_KEY] as string : state.freshConfig.writerProviderId,
            model: typeof state.runSettings[WRITER_MODEL_KEY] === "string" && state.runSettings[WRITER_MODEL_KEY] ? state.runSettings[WRITER_MODEL_KEY] as string : state.freshConfig.writerModel,
          };
          const hot = await sticky.hotWriter(input.projectId, input.runId, input.task.area, wanted);
          if (hot) await continueWith(deps, state, input, hot, "next-task", "");
        }
      };
