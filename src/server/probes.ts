import { createAttempt, createRun, getAttempt, loadPrototypeConfig, setRunThread, transitionAttempt } from "../database";
import { fullAccessSpawn } from "./pm-spawn";
import { id, stringAt, valueAt } from "./values";
import type { ServerCore } from "./core";
import type { Services } from "./services";

export function createProbes(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;

  async function startCancelProbe(projectId: string, pmThreadId: string): Promise<Record<string,unknown>> {
    const config = loadPrototypeConfig(db, projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${projectId}`);
    const runId = id("lpcancelrun");
    const taskId = id("lpcanceltask");
    const attemptId = id("lpcancelattempt");
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    createAttempt(db, { id:attemptId, runId, taskId });
    transitionAttempt(db, attemptId, "spawn_requested");
    try {
      const spawned = await fullAccessSpawn(bb, {
        projectId,
        providerId:config.writerProviderId,
        model:config.writerModel,
        prompt:"Lane Pilot cancel probe. Run `sleep 300` using Bash before responding. Do not edit any file.",
        environment:{ type:"host", hostId:config.hostId, workspace:{ type:"unmanaged", path:config.writerWorkspacePath } },
        visibility:"hidden",
        pluginMetadata:{ role:"writer", lanePilotRunId:runId, lanePilotTaskId:taskId, attemptId, parentPmThreadId:pmThreadId },
        executionInputSources:{ providerId:"explicit", model:"explicit" },
      });
      const threadId = stringAt(spawned, "id");
      if (!threadId) throw new Error("threads.spawn returned no cancel-probe thread id");
      transitionAttempt(db, attemptId, "running", { threadId });
      return { runId, taskId, attemptId, threadId, state:"running" };
    } catch (cause) {
      transitionAttempt(db, attemptId, "spawn_rejected", { reason:cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    }
  }

  async function startProviderErrorProbe(projectId: string, pmThreadId: string): Promise<Record<string,unknown>> {
    const config = loadPrototypeConfig(db, projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${projectId}`);
    const runId = id("lperrorrun");
    const taskId = id("lperrortask");
    const attemptId = id("lperrorattempt");
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    createAttempt(db, { id:attemptId, runId, taskId });
    transitionAttempt(db, attemptId, "spawn_requested");
    const spawned = await fullAccessSpawn(bb, {
      projectId,
      providerId:config.writerProviderId,
      model:"__lane_pilot_missing_model__",
      prompt:"Lane Pilot provider-error probe. Reply only ok.",
      environment:{ type:"host", hostId:config.hostId, workspace:{ type:"unmanaged", path:config.writerWorkspacePath } },
      visibility:"hidden",
      pluginMetadata:{ role:"writer", lanePilotRunId:runId, lanePilotTaskId:taskId, attemptId, parentPmThreadId:pmThreadId },
      executionInputSources:{ providerId:"explicit", model:"explicit" },
    });
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("threads.spawn returned no provider-error probe thread id");
    transitionAttempt(db, attemptId, "running", { threadId });
    const observed = await bb.sdk.threads.wait({ threadId, status:"error", timeoutMs:60_000 });
    const observedThread = valueAt(observed, "thread");
    if (stringAt(observedThread, "status") !== "error") throw new Error("provider-error probe did not observe error status");
    transitionAttempt(db, attemptId, "provider_error", { threadId, reason:"observed provider error from deliberately missing model" });
    await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
    await bb.sdk.threads.archive({ threadId }).catch(() => undefined);
    return { runId, taskId, attemptId, threadId, observedStatus:"error", state:"provider_error" };
  }

  async function startAmbiguousProbe(projectId: string, pmThreadId: string): Promise<Record<string,unknown>> {
    const config = loadPrototypeConfig(db, projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${projectId}`);
    const runId = id("lpambiguousrun");
    const taskId = id("lpambiguoustask");
    const attemptId = id("lpambiguousattempt");
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    createAttempt(db, { id:attemptId, runId, taskId });
    transitionAttempt(db, attemptId, "spawn_requested");
    transitionAttempt(db, attemptId, "spawn_unknown", { reason:"live ambiguous reconcile probe" });
    const threadIds: string[] = [];
    try {
      for (const ordinal of [1, 2]) {
        const spawned = await fullAccessSpawn(bb, {
          projectId,
          providerId:config.writerProviderId,
          model:config.writerModel,
          prompt:`Lane Pilot ambiguous reconcile probe ${ordinal}.`,
          sendAt:Date.now() + 86_400_000,
          environment:{ type:"host", hostId:config.hostId, workspace:{ type:"unmanaged", path:config.writerWorkspacePath } },
          visibility:"hidden",
          pluginMetadata:{ role:"ambiguous-probe", probeOrdinal:ordinal },
          executionInputSources:{ providerId:"explicit", model:"explicit" },
        });
        const threadId = stringAt(spawned, "id");
        if (!threadId) throw new Error("threads.spawn returned no ambiguous-probe thread id");
        threadIds.push(threadId);
      }
      for (const threadId of threadIds) {
        await bb.sdk.threads.updatePluginMetadata({
          threadId,
          set:{ role:"writer", lanePilotRunId:runId, lanePilotTaskId:taskId, attemptId, parentPmThreadId:pmThreadId },
          remove:["probeOrdinal"],
        });
      }
      let reconcileError = "";
      try {
        const attempt = getAttempt(db, attemptId);
        if (!attempt) throw new Error("ambiguous probe attempt disappeared");
        await services.reconcileAttemptThread(projectId, attempt);
      } catch (cause) {
        reconcileError = cause instanceof Error ? cause.message : String(cause);
      }
      const persisted = getAttempt(db, attemptId);
      if (persisted?.state !== "blocked" || persisted.thread_id !== null) {
        throw new Error(`ambiguous reconcile did not fail closed: ${JSON.stringify(persisted)}`);
      }
      return {
        runId, taskId, attemptId, threadIds,
        metadataUpdated:true,
        reconcileError,
        state:persisted.state,
        reason:"reconcile_ambiguous",
      };
    } finally {
      for (const threadId of threadIds) {
        await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
        await bb.sdk.threads.delete({ threadId, childThreadsConfirmed:true }).catch(() => undefined);
      }
    }
  }

  return { startCancelProbe, startProviderErrorProbe, startAmbiguousProbe };
}
