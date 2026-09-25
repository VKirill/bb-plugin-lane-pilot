import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  claimActivation,
  createRun,
  freezeRunBinding,
  getActivation,
  getRun,
  loadPrototypeConfig,
  releaseActivation,
  setRunState,
  setRunThread,
  type LanePilotDatabase,
} from "./database";
import { buildRunPolicy } from "./stages/run-policy";

function valueAt(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function stringAt(value: unknown, key: string): string | null {
  const found = valueAt(value, key);
  return typeof found === "string" && found.length > 0 ? found : null;
}

export async function bindNativeLaneRun(input: {
  bb: BbPluginApi;
  db: LanePilotDatabase;
  threadId: string;
  projectId: string;
  hostId: string;
  workspacePath: string;
  environmentId?: string | null;
}): Promise<{ runId: string }> {
  const existing = getActivation(input.db, input.projectId);
  if (existing?.pm_thread_id === input.threadId) return { runId: existing.run_id };
  if (existing && !existing.pm_thread_id.startsWith("pending:")) {
    const run = getRun(input.db, existing.run_id);
    if (run && (run.state === "pending" || run.state === "running")) {
      throw new Error(
        `Lane Pilot is already active in this project (thread ${existing.pm_thread_id}). A second activation is blocked.`,
      );
    }
  }
  const config = loadPrototypeConfig(input.db, input.projectId);
  if (!config) throw new Error(`Lane Pilot prototype is not configured for ${input.projectId}`);
  let environmentId = input.environmentId?.trim() || null;
  if (!environmentId) {
    const thread = await input.bb.sdk.threads.get({ threadId: input.threadId }).catch(() => null);
    environmentId = stringAt(thread, "environmentId");
  }
  if (!environmentId) throw new Error("Native send needs the real environment id. Lane Pilot does not invent it.");
  const runId = `lprun_${randomUUID().replaceAll("-", "")}`;
  createRun(input.db, runId, input.projectId, "cli", null, "none", buildRunPolicy({}), null);
  claimActivation(input.db, { projectId: input.projectId, pmThreadId: `pending:${input.threadId}`, runId });
  try {
    await input.bb.sdk.threads.updatePluginMetadata({
      threadId: input.threadId,
      set: { role: "pm", lanePilotRunId: runId },
    });
    if (!freezeRunBinding(input.db, runId, {
      hostId: input.hostId,
      workspacePath: input.workspacePath,
      environmentId,
    })) {
      throw new Error("native environment CAS failed; run is no longer pending or already has a binding");
    }
    setRunThread(input.db, runId, input.threadId);
    claimActivation(input.db, { projectId: input.projectId, pmThreadId: input.threadId, runId });
    return { runId };
  } catch (cause) {
    setRunState(input.db, runId, "blocked");
    releaseActivation(input.db, input.projectId, runId);
    throw cause;
  }
}
