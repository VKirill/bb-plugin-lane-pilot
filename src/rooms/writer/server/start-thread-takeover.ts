import type { DirtSnapshot } from "../cli-outcome";
import { endSpawnFailure, getReasoningTrace, getRunSettingsScopes } from "../../storage";
import { bestEffort } from "@lane-pilot/kit";
;
import { REPLAY_CHECK_FAILED } from "../../contracts";
import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { attemptFeedback } from "./writer-task";
import { stickyTurnPromptWithRules } from "./writer-knowledge";
import { parseMemorySettings } from "../../memory";
import { retargetTask } from "../../tasks";


import { type WriterTaskState } from "./start-task-state";

import { listReturns, renderReturnNotes } from "../../stage-return";


import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput } from "./start-task-state";
      /** Takes over an existing writer thread for this attempt; false leaves the attempt to a fresh spawn. */
      export const continueWith = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, writer:NonNullable<Awaited<ReturnType<StartWriterTaskDeps["sticky"]["hotWriter"]>>>, kind:"next-task"|"retry"|"merge", previousAttempt:string, keepDirt?:DirtSnapshot[]):Promise<boolean> => {
        const { ctx, services, sticky } = deps;
        const { bb, db, effectiveProjectSettings, host } = ctx;
        const bound = retargetTask(state.freshTask,writer.workspacePath);
        // The third turn of this thread gets the digest of what it already did, not the raw trajectory.
        let feedback = previousAttempt;
        if (kind === "retry" && writer.turns >= 2) {
          const listed = await bestEffort(ctx.log, "writer attempt feedback events", listThreadEventsRaw(bb, { threadId: writer.threadId, order: "desc", limit: "50" }), null);
          feedback = attemptFeedback(writer.turns + 1, listed?.ok ? listed.events as Parameters<typeof attemptFeedback>[1] : [], previousAttempt);
        }
        // The next task of an area is a different contract: its rules come with it (writer-knowledge.ts); a retry or a merge keeps the brief's.
        const memorySettings = parseMemorySettings((await bestEffort(ctx.log, "writer memory settings", effectiveProjectSettings(input.projectId, getRunSettingsScopes(db, input.runId)), null))?.values ?? {});
        const turnPrompt = await stickyTurnPromptWithRules({ db, host, chainForRun:(runId) => services.ruleScan.chainForRun(runId), log:ctx.log },
          { projectId:input.projectId, runId:input.runId, hostId:state.freshConfig.hostId, task:bound, memorySettings },
          { kind, task:bound, previousAttempt:kind === "merge" && !previousAttempt.includes(REPLAY_CHECK_FAILED) ? "" : feedback, liveFolder: state.liveFolder });
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
        const { ctx, sticky } = deps;
        if (!state.writerThreadId && input.task.area && !state.liveFolder) {
          const wanted = {
            providerId: typeof state.runSettings["writer.provider"] === "string" ? state.runSettings["writer.provider"] as string : state.freshConfig.writerProviderId,
            model: typeof state.runSettings["writer.model"] === "string" && state.runSettings["writer.model"] ? state.runSettings["writer.model"] as string : state.freshConfig.writerModel,
          };
          const hot = await sticky.hotWriter(input.projectId, input.runId, input.task.area, wanted);
          if (hot) await continueWith(deps, state, input, hot, "next-task", "");
        }
      };
