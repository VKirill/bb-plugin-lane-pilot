import { getRunSettingsScopes, loadProjectSettings } from "../../storage";
import { rotatedWriterSettings, writerFallbackChain, writerFallbacks } from "@lane-pilot/models";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

/** The writers that may take the task after the primary one: its fallbacks in turn, then the PM's model. Read fresh: the owner may change them mid-task. */
export const otherWriters = (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput) => {
  const { ctx } = deps;
  const { db } = ctx;
  const loadedSettings=loadProjectSettings(db,input.projectId,getRunSettingsScopes(db,input.runId));
  const settings=state.writerOverlay ? { ...loadedSettings, ...state.writerOverlay } : rotatedWriterSettings(loadedSettings, input.taskId);
  const primaryProvider=typeof settings["writer.provider"] === "string" ? settings["writer.provider"] as string : input.config.writerProviderId;
  const primaryModel=typeof settings["writer.model"] === "string" && settings["writer.model"] ? settings["writer.model"] as string : input.config.writerModel;
  const pmSelection={providerId:input.config.pmProviderId,model:input.config.pmModel};
  return { settings, pmSelection, fallbackList:writerFallbackChain({providerId:primaryProvider,model:primaryModel},writerFallbacks(settings),pmSelection) };
};
