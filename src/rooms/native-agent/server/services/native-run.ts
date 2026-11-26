import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  claimRunPlacement,
  createRun,
  findOpenNativeRun,
  getRun,
  setRunState,
  setRunThread,
  type LanePilotDatabase,
} from "../../../storage";
import { buildRunPolicy } from "../../../tasks";

/** Each native chat owns its run: no project setup and no project-wide lock. */
export function claimNativeLaneRun(input: {
  db: LanePilotDatabase;
  threadId: string;
  projectId: string;
}): { runId: string; created: boolean } {
  const existing = findOpenNativeRun(input.db, input.projectId, input.threadId);
  if (existing) return { runId: existing, created: false };
  const runId = `lprun_${randomUUID().replaceAll("-", "")}`;
  createRun(input.db, runId, input.projectId, "cli", null, "none", buildRunPolicy({}), null);
  return { runId, created: true };
}

export async function attachNativeLaneClaim(input: {
  bb: BbPluginApi;
  db: LanePilotDatabase;
  threadId: string;
  projectId: string;
  runId: string;
}): Promise<void> {
  try {
    await input.bb.sdk.threads.updatePluginMetadata({
      threadId: input.threadId,
      set: { role: "pm", lanePilotRunId: input.runId },
    });
    setRunThread(input.db, input.runId, input.threadId);
  } catch (cause) {
    setRunState(input.db, input.runId, "blocked");
    throw cause;
  }
}

export function finalizeNativeLaneBinding(input: {
  db: LanePilotDatabase;
  runId: string;
  hostId: string;
  workspacePath: string;
  environmentId: string;
}): boolean {
  const run = getRun(input.db, input.runId);
  if (!run) throw new Error("native run disappeared before environment attach");
  if (run.writer_environment_id) {
    if (run.writer_environment_id !== input.environmentId) {
      throw new Error("native environment changed after the Lane Pilot run was bound; the active run cannot move. Use lane_pilot_relay action handoff with targetProjectId, targetHostId and targetPath to start a new child Pilot in the desired checkout.");
    }
    return true;
  }
  return claimRunPlacement(input.db, { hostId: input.hostId, workspacePath: input.workspacePath, environmentId: input.environmentId, runId: input.runId });
}

export function nativeRunReady(db: LanePilotDatabase, runId: string): boolean {
  const run = getRun(db, runId);
  return Boolean(run?.writer_environment_id && run.writer_workspace_path);
}

export function ownedNativePmRun(db: LanePilotDatabase, input: {
  runId: string;
  threadId: string;
  projectId: string;
  role: unknown;
}): NonNullable<ReturnType<typeof getRun>> | null {
  if (input.role !== "pm") return null;
  const run = getRun(db, input.runId);
  if (!run || run.kind !== "cli") return null;
  if (run.pm_thread_id !== input.threadId) return null;
  if (run.project_id !== input.projectId) return null;
  return run;
}
