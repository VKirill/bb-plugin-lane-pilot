import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { getRun, type LanePilotDatabase } from "../../storage";
import { ToolError } from "../../contracts/server";
import type { Realtime } from "./realtime";

/** What every server module gets instead of reaching into the closure of `plugin()`. */
export type ServerContext = {
  bb: BbPluginApi;
  db: LanePilotDatabase;
  log: (message: string) => void;
  isDisposed: () => boolean;
  /** Tells open screens to re-read; absent in a bare context built by a test. */
  realtime?: Realtime;
}

/**
 * The calling thread's plugin metadata: `context.experimental_vkPluginMetadata` carries the same row on VK cores
 * (core fba7d8b0a), saving the loopback call; the SDK read stays the fallback on stock BB.
 */
export async function callerPluginMetadata(
  bb: BbPluginApi,
  context: { threadId: string | null; experimental_vkPluginMetadata?: unknown },
): Promise<Record<string, unknown> | null> {
  if (context.experimental_vkPluginMetadata !== undefined) return context.experimental_vkPluginMetadata as Record<string, unknown> | null;
  if (!context.threadId) return null;
  return (await bb.sdk.threads.getPluginMetadata({ threadId: context.threadId })) as Record<string, unknown> | null;
}

/** The calling thread's plugin metadata, or the one refusal every PM-only agent tool shares. */
async function pmThreadMetadata(
  bb: BbPluginApi,
  context: { threadId: string | null; experimental_vkPluginMetadata?: unknown },
): Promise<Record<string, unknown>> {
  const metadata = (await callerPluginMetadata(bb, context)) as Record<string, unknown> | null;
  if (metadata?.role !== "pm") {
    throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
  }
  return metadata;
}

/** That the calling thread is a Lane Pilot PM thread, for a tool that acts on the thread itself and names no run. */
export async function requirePmThread(
  bb: BbPluginApi,
  context: { threadId: string | null; experimental_vkPluginMetadata?: unknown },
): Promise<void> {
  await pmThreadMetadata(bb, context);
}

/** The run id of the calling Lane Pilot PM thread, for a tool that acts on its run. */
export async function requirePmThreadRun(
  bb: BbPluginApi,
  context: { threadId: string | null; experimental_vkPluginMetadata?: unknown },
): Promise<string> {
  const metadata = await pmThreadMetadata(bb, context);
  const runId = typeof metadata.lanePilotRunId === "string" ? metadata.lanePilotRunId : null;
  if (!runId) {
    throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
  }
  return runId;
}

/** The PM thread of an open run of this project; anything else is refused before any work starts. */
export function requirePmRun(db: LanePilotDatabase, input: { runId: string; threadId: string; projectId: string }): { id: string; project_id: string } {
  const run = getRun(db, input.runId);
  if (!run || run.project_id !== input.projectId || run.pm_thread_id !== input.threadId || run.closed_at) {
    throw new Error("runId does not belong to this active Lane Pilot PM thread and project");
  }
  return run;
}
