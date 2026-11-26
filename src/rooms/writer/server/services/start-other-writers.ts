import { WRITER_PROVIDER_KEY, WRITER_MODEL_KEY } from "../../settings";
import { getRunSettingsScopes, loadProjectSettings } from "../../../storage";
import { rotatedWriterSettings, writerFallbackChain, writerFallbacks } from "@lane-pilot/models";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

/** The writers that may take the task after the primary one: its fallbacks in turn, then the PM's model. Read fresh: the owner may change them mid-task. */
export const otherWriters = (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput) => {
  const { ctx } = deps;
  const { db } = ctx;
  const loadedSettings=loadProjectSettings(db,input.projectId,getRunSettingsScopes(db,input.runId));
  const settings=rotatedWriterSettings(loadedSettings, input.taskId);
  const primaryProvider=typeof settings[WRITER_PROVIDER_KEY] === "string" ? settings[WRITER_PROVIDER_KEY] as string : input.config.writerProviderId;
  const primaryModel=typeof settings[WRITER_MODEL_KEY] === "string" && settings[WRITER_MODEL_KEY] ? settings[WRITER_MODEL_KEY] as string : input.config.writerModel;
  const pmSelection={providerId:input.config.pmProviderId,model:input.config.pmModel};
  return { settings, pmSelection, fallbackList:writerFallbackChain({providerId:primaryProvider,model:primaryModel},writerFallbacks(settings),pmSelection) };
};
