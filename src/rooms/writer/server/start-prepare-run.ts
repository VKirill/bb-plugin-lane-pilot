import { configuredSetting } from "../../contracts/server";
import { blockedReasonCount, countAttempts, getRunSettingsScopes, noteCleanAdmission, parkAttemptWake, taskBasePath, trailingQueuedParks, transitionAttempt } from "../../storage";
import { rotatedWriterSettings } from "@lane-pilot/models";
import { postOwnerItem } from "../../owner-waiting";
import { closeWriterStages } from "../../runs/server";
import { loadWriterPin } from "../writer-model-pin";
import { liveBackupKey } from "./start-live-folder";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

const STORE_READ_PARK_LIMIT = 5;

export const blockBeforeWriter = (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, reason:string) => {
  const { ctx } = deps;
  const { db, refreshRun } = ctx;
  transitionAttempt(db, state.attemptId, "blocked", { reason });
  state.last = { status:"blocked", reason, attemptId: state.attemptId };
  closeWriterStages(db, { runId:input.runId, taskId:input.taskId, plan:input.plan, terminal:"failed",
    attempt:countAttempts(db, input.runId, input.taskId), reason });
  refreshRun(input.runId);
};

/** A plugin-store read that fails is "state unknown", not a task failure: park the attempt for the wake sweep; after the bound it blocks with an owner item. Shared by prepareRun and the pause-read bound. */
export const parkForStoreRead = (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, cause: unknown): false => {
  const { ctx } = deps;
  const { db } = ctx;
  const message = cause instanceof Error ? cause.message : String(cause);
  // Bounded: a store that stays unreadable is not transient. After the park limit the attempt blocks with a
  // clear reason and the owner gets one item per block (the sequence key reopens after the last one was closed).
  if (trailingQueuedParks(db, state.attemptId, "store_read:") + 1 >= STORE_READ_PARK_LIMIT) {
    const reason = `store_read: plugin store unreadable after ${STORE_READ_PARK_LIMIT} attempts: ${message.slice(0, 160)}`;
    blockBeforeWriter(deps, state, input, reason);
    postOwnerItem(db, { key: `store-read:${state.attemptId}:${blockedReasonCount(db, state.attemptId, "store_read:")}`, source: "writer", kind: "store_read", projectId: input.projectId, wake: true,
      what: "Запись остановлена: хранилище плагина не читается",
      why: `${STORE_READ_PARK_LIMIT} попыток подряд не смогли прочитать настройки перед запуском писателя — это постоянный сбой хранилища, а не разовый.`,
      evidence: [{ kind: "run", ref: input.runId }, { kind: "task", ref: input.taskId }] });
    return false;
  }
  const reason = `store_read: ${message.slice(0, 200)}`;
  parkAttemptWake(db, state.attemptId, reason, Date.now() + 30_000);
  ctx.log(`writer ${input.taskId}: plugin store unreadable before spawn (${reason}); the attempt retries in 30 s`);
  state.last = { status:"queued", reason, attemptId: state.attemptId };
  return false;
};

/** Settings, writer pick, budget, the live-folder flag and its backup: everything a later step needs in place. False = parked for a transient store read. */
export const prepareRun = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<boolean> => {
  const { ctx, services, pickWriter } = deps;
  const { bb, db, effectiveProjectSettings, runPolicyFor } = ctx;
  state.policy=runPolicyFor(input.runId);
  // The pick, the pin, the live backup and the settings scopes live in the plugin store: a read that fails is
  // transient — park the attempt for the wake sweep instead of blocking it on a storage hiccup.
  try {
    state.baseSettings=(await effectiveProjectSettings(input.projectId,getRunSettingsScopes(db,input.runId))).values;
    state.writerOverlay=await pickWriter(state.baseSettings, input);
    state.runSettings=state.writerOverlay ? { ...state.baseSettings, ...state.writerOverlay } : rotatedWriterSettings(state.baseSettings, input.taskId);
    // The task's writer pair, pinned across restarts and re-dispatches (hive H-01): a kept pin wins over a fresh
    // rotation; the pair moves only on a provider failure or a failure-class intervention, and the move's reason is kept.
    const pairPin = configuredSetting(state.runSettings, "writer.pair_pin") === "off" ? null : await loadWriterPin(bb.storage.kv as never, input.runId, input.taskId);
    if (pairPin) state.runSettings = { ...state.runSettings, "writer.provider": pairPin.providerId, "writer.model": pairPin.model };
  } catch (cause) { return parkForStoreRead(deps, state, input, cause); }
  // Only the writer keys travel to the spawn: the spawn reads the stored settings again, and must see this choice, not the project's.
  state.writerChoice=Object.fromEntries(Object.entries(state.runSettings).filter(([key, value]) => key.startsWith("writer.") && value !== state.baseSettings[key]));
  state.budget=services.runBudgetFor(input.runId,state.runSettings);
  // Tasks run side by side only when they cannot touch the same files: one whose owns_paths overlap an
  // earlier open task's (in any run on the same checkout) waits for it, instead of conflicting at the merge.
  state.runFolder = taskBasePath(db, input.runId, input.taskId) ?? input.task.project_cwd;
  state.liveFolder = await services.isLiveFolder(input.runId, input.config.hostId, state.runFolder);
  // An attempt resumed on its writer's thread (the PM's answer, a reload) goes on under the backup it began with.
  if (state.liveFolder && state.writerThreadId) {
    try {
      const saved = await bb.storage.kv.get(liveBackupKey(state.attemptId));
      if (typeof saved === "string") state.liveBackupId = saved;
    } catch (cause) { return parkForStoreRead(deps, state, input, cause); }
  }
  // A clean read after parks resets the streak: without the marker the journal still ends in store_read rows
  // and one more failure much later would count them all and block a recovered store.
  if (trailingQueuedParks(db, state.attemptId, "store_read:") > 0) noteCleanAdmission(db, state.attemptId);
  return true;
};
