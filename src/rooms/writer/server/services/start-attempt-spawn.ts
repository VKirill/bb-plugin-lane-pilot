import { WRITER_PROVIDER_KEY, WRITER_MODEL_KEY, WRITER_REASONING_EFFORT_KEY } from "../../settings";
import { budgetStopReason } from "@lane-pilot/resilience";
import { writerFallbackChain, writerFallbacks } from "@lane-pilot/models";
import { countAttempts, getAttempt, listAttemptsForTask, transitionAttempt } from "../../../storage";
import { bestEffort } from "@lane-pilot/kit";
import { noteWriterPair } from "../../models/writer-model-pin";
import { failureClassCooldownMs } from "../../../contracts";
import { walkWriterChain, type ChainWalk } from "./writer-hold";
import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { attemptFeedback, previousAttemptBrief } from "../../models/writer-brief-feedback";
import { pendingWordTake } from "../repositories/pending-word";
import { retargetTask } from "../../../tasks";
import { failureClass } from "../../../contracts";


import { isOwnFailure } from "../repositories/start-failure-records";
import { type WriterTaskState } from "./start-task-state";
import { bindLiveBackup } from "./start-live-folder";
import { parkForWriter, writerHoldDeps } from "./start-writer-holds";

import { collectHandoffBrief } from "./writer-handoff";


import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput } from "./start-task-state";

/** Fresh spawn or PM-reassigned continuation for the current attempt; null when the loop goes on. */
export const spawnFreshWriter = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<"stop"|"break"|null> => {
        const { ctx, services } = deps;
        const { bb, db, host } = ctx;
        if (!state.writerThreadId && !state.halfBound && state.last.status !== "accepted") {
          const reassigned = state.pendingReassign;
          const primaryPair = { providerId:typeof state.runSettings[WRITER_PROVIDER_KEY] === "string" && state.runSettings[WRITER_PROVIDER_KEY] ? state.runSettings[WRITER_PROVIDER_KEY] as string : state.freshConfig.writerProviderId,
            model:typeof state.runSettings[WRITER_MODEL_KEY] === "string" && state.runSettings[WRITER_MODEL_KEY] ? state.runSettings[WRITER_MODEL_KEY] as string : state.freshConfig.writerModel };
          // H2: the gate's sources answer before the attempt is spent. A free member of the chain (the task's writer,
          // its fallbacks, the PM) spawns in this attempt — the next one when the writer itself is held; nobody free
          // parks the attempt queued until the earliest hold ends, instead of the spawn_rejected loop it used to run.
          const chainMembers = [{ ...primaryPair, reasoningLevel:typeof state.runSettings[WRITER_REASONING_EFFORT_KEY] === "string" ? state.runSettings[WRITER_REASONING_EFFORT_KEY] as string : "medium" },
            ...writerFallbackChain(primaryPair, writerFallbacks(state.runSettings), { providerId:state.freshConfig.pmProviderId, model:state.freshConfig.pmModel })];
          // A PM reassignment names its writer: it is tried as ordered (its own refusal is the old path).
          const walked = reassigned?.request.selection
            ? { free:{ member:chainMembers[0]!, index:0 }, allUnsupported:false, allOff:false, off:[], shortest:undefined, wakeAt:null, holds:[] } as ChainWalk
            : await walkWriterChain(chainMembers, { hostId:state.freshConfig.hostId, settings:state.runSettings, appetite:{ tokens:(input.task as { appetite?: { tokens?: number } }).appetite?.tokens } }, writerHoldDeps(deps));
          if (await parkForWriter(deps, state, input, state.attemptId, walked)) return "stop";
          const spawnSettings = walked.free && walked.free.index > 0
            ? { ...state.writerChoice, [WRITER_PROVIDER_KEY]:walked.free.member.providerId, [WRITER_MODEL_KEY]:walked.free.member.model,
                ...(walked.free.member.reasoningLevel ? { [WRITER_REASONING_EFFORT_KEY]:walked.free.member.reasoningLevel } : {}) }
            : state.writerChoice;
          if (walked.free && walked.free.index > 0)
            ctx.log(`writer ${input.taskId}: ${primaryPair.providerId}/${primaryPair.model} is held (${walked.shortest?.hold.reason ?? "unknown"}); spawning ${walked.free.member.providerId}/${walked.free.member.model} in the same attempt`);
          // A pause the last failure's class asks for before the next attempt (writer.class_cooldowns, hive H-14): it
          // doubles with each consecutive attempt that ended in the same class (SMA ae_auto_retry).
          const lastClass = failureClass(String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null);
          let sameClassStreak = 0;
          for (const row of [...listAttemptsForTask(db, input.runId, input.taskId)].reverse()) {
            if (row.id === state.attemptId || ["queued","spawn_requested","spawn_unknown","running","cancel_requested"].includes(row.state)) continue;
            if (failureClass(row.state, getAttempt(db, row.id)?.reason) !== lastClass) break;
            sameClassStreak += 1;
          }
          const classCooldown = failureClassCooldownMs(lastClass, state.runSettings, Math.max(1, sameClassStreak));
          if (classCooldown > 0) await new Promise((resolve) => setTimeout(resolve, classCooldown));
          if (!reassigned) state.budget.noteAttempt();
          const afterAttempt=state.budget.check();
          if (!afterAttempt.ok) {
            const reason=budgetStopReason(afterAttempt.exceeded);
            transitionAttempt(db, state.attemptId, "blocked", { reason });
            state.last = { status:"blocked", reason, attemptId: state.attemptId };
            return "break";
          }
          const carried=reassigned?.from?.thread_id&&reassigned.from.workspace_path&&!state.liveFolder ? {
            workspacePath:reassigned.from.workspace_path, environmentId:reassigned.from.environment_id, dirtBefore:reassigned.from.dirt_before,
            fromThreadId:reassigned.from.thread_id,
            brief:await collectHandoffBrief({ bb, host, hostId:input.config.hostId, threadId:reassigned.from.thread_id, workspacePath:reassigned.from.workspace_path,
              stopReason:`reassigned by the PM: ${reassigned.request.reason}` }),
          } : undefined;
          const requested = input.fallbackSelection ? undefined : reassigned?.request.selection;
          state.pendingReassign=null;
          const prevBrief = previousAttemptBrief(state.last.status && isOwnFailure(state.last) ? state.last : state.own.failure ?? (state.last.status ? state.last : null), state.freshTask, undefined, state.liveFolder);
          // A fresh thread has none of the failed attempt's context: from the second attempt on it gets the
          // digest of that attempt's thread (what it did, what failed), not only the failure line (rank 5).
          const failedThreadId=(typeof state.last.attemptId==="string" ? getAttempt(db,state.last.attemptId)?.thread_id : null) ?? null;
          const listedPrev=failedThreadId&&countAttempts(db,input.runId,input.taskId)>=2&&typeof (bb.sdk.threads as {events?:{list?:unknown}}|undefined)?.events?.list==="function"
            ? await bestEffort(ctx.log, "writer previous attempt events", listThreadEventsRaw(bb,{threadId:failedThreadId,order:"desc",limit:"50"}), null) : null;
          const prevEvents=listedPrev?.ok ? listedPrev.events as Parameters<typeof attemptFeedback>[1] : [];
          const prevFeedback=attemptFeedback(countAttempts(db,input.runId,input.taskId),prevEvents,prevBrief,true);
          // A PM's word the running writer could not take rides this fresh thread's brief, once (sma as_redirect_deferred).
          const pendingWord=await pendingWordTake(bb.storage.kv as never,input.runId,input.taskId).catch(()=>null);
          const spawned = await services.spawnWriterAttempt({
            projectId:input.projectId, runId:input.runId, taskId:input.taskId, attemptId: state.attemptId,
            config:state.freshConfig, task:state.freshTask, plan:input.plan, pmThreadId:input.pmThreadId, pmReadContext: state.pmReadContext, writerSettings:spawnSettings,
            retryIndex:Math.max(0,countAttempts(db,input.runId,input.taskId)-1),
            // A fresh writer starts from main: of the failures before it, the task's own is the one to avoid, not a provider's cut.
            previousAttempt:[prevFeedback, pendingWord].filter(Boolean).join("\n\n"),
            ...(input.fallbackSelection ? { emergency: input.fallbackSelection } : requested ? { emergency:{...requested, reason:"reassigned by the PM"} } : {}),
            ...(!input.fallbackSelection && carried ? { continuation:carried } : {}),
          });
          if (!spawned.ok) {
            state.last = { status:spawned.status, reason:spawned.reason, attemptId:spawned.attemptId };
          } else {
            state.writerThreadId = spawned.threadId;
            if (state.liveFolder) { state.liveBackupId = state.attemptId; await bindLiveBackup(deps, state); }
            state.writerSelection=spawned.providerId&&spawned.model?{
              providerId:spawned.providerId,model:spawned.model,
              reasoningLevel:spawned.reasoningLevel,serviceTier:spawned.serviceTier,selectionSource:spawned.selectionSource,
            }:undefined;
            if (state.writerSelection) await noteWriterPair(bb.storage.kv as never, input.runId, input.taskId,
              { providerId:state.writerSelection.providerId, model:state.writerSelection.model }, "initial", bb.log);
            state.activeConfig = state.freshConfig;
            state.activeTask = retargetTask(state.freshTask,spawned.workspacePath);
            // In a folder without git every attempt of the task starts from the same state (the owned files are rolled
            // back), so a file outside owns_paths that an earlier attempt left behind keeps counting as changed until undone.
            state.dirtBefore = state.liveFolder && state.baselineDirtBefore ? state.baselineDirtBefore : spawned.dirtBefore;
            state.baselineDirtBefore ??=[...spawned.dirtBefore];
            state.baselineWorkspacePath ??=spawned.workspacePath;
            state.executionPacketSha256 = spawned.executionPacketSha256 ?? null;
          }
        }
        return null;
}
