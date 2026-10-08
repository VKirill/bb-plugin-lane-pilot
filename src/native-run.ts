import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createRun,
  findOpenNativeRun,
  getRun,
  setRunState,
  setRunThread,
  type LanePilotDatabase,
} from "./database";
import { buildRunPolicy } from "./rooms/tasks/run-policy";

export type NativeDispatchWorkspace =
  | { phase: "ready"; hostId: string; workspacePath: string; environmentId: string | null }
  | { phase: "pending"; hostId: string | null };

export function inspectDispatchPlacement(ctx: {
  host?: { id?: string } | null;
  environment?: { id?: string | null; path?: string | null; hostId?: string | null } | null;
  environmentIntent?: unknown;
}): {
  kind: string;
  providerId: string | null;
  machineType: string | null;
  hostId: string | null;
  pathPresent: boolean;
  inputKeys: string;
} {
  const intent = ctx.environmentIntent && typeof ctx.environmentIntent === "object"
    ? ctx.environmentIntent as Record<string, unknown>
    : null;
  const kind = typeof intent?.kind === "string" ? intent.kind : "null";
  const providerId = typeof intent?.environmentProviderId === "string" ? intent.environmentProviderId : null;
  const machine = intent?.machine && typeof intent.machine === "object" && !Array.isArray(intent.machine)
    ? intent.machine as { type?: unknown; hostId?: unknown }
    : null;
  const machineType = typeof machine?.type === "string" ? machine.type : null;
  const machineHost = machineType === "existing" && typeof machine?.hostId === "string" ? machine.hostId.trim() : "";
  const inputs = intent?.inputs && typeof intent.inputs === "object" && !Array.isArray(intent.inputs)
    ? intent.inputs as Record<string, unknown>
    : null;
  const pathValue = inputs ? Reflect.get(inputs, "path") : undefined;
  const pathPresent = typeof pathValue === "string" && pathValue.startsWith("/");
  const hostId = ctx.environment?.hostId?.trim() || ctx.host?.id?.trim() || machineHost || null;
  return {
    kind,
    providerId,
    machineType,
    hostId: hostId || null,
    pathPresent,
    inputKeys: inputs ? Object.keys(inputs).sort().join(",") : "",
  };
}

export function projectCheckoutIntentPath(intent: unknown): string | null {
  const placement = inspectDispatchPlacement({ environmentIntent: intent });
  if (placement.kind !== "provider" || placement.providerId !== "project-checkout") return null;
  if (!placement.pathPresent) return null;
  const inputs = intent && typeof intent === "object"
    ? Reflect.get(intent, "inputs")
    : null;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return null;
  const path = Reflect.get(inputs, "path");
  return typeof path === "string" && path.startsWith("/") ? path : null;
}

export function resolveNativeDispatchWorkspace(ctx: {
  host?: { id?: string } | null;
  environment?: { id?: string | null; path?: string | null; hostId?: string | null } | null;
  environmentIntent?: unknown;
}): NativeDispatchWorkspace {
  const attachedPath = ctx.environment?.path?.trim() || null;
  const placement = inspectDispatchPlacement(ctx);
  if (attachedPath && placement.hostId) {
    return {
      phase: "ready",
      hostId: placement.hostId,
      workspacePath: attachedPath,
      environmentId: ctx.environment?.id?.trim() || null,
    };
  }
  const path = projectCheckoutIntentPath(ctx.environmentIntent);
  if (path && placement.hostId) {
    return { phase: "ready", hostId: placement.hostId, workspacePath: path, environmentId: null };
  }
  if (placement.kind === "environment") {
    return { phase: "pending", hostId: placement.hostId };
  }
  if (placement.kind === "provider" && placement.providerId === "project-checkout") {
    return { phase: "pending", hostId: placement.hostId };
  }
  throw new Error("Native send needs the selected project-checkout host and path. Lane Pilot does not invent them.");
}

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
      throw new Error("native environment changed after the Lane Pilot run was bound");
    }
    return true;
  }
  const result = input.db.prepare(`UPDATE lane_pilot_run
    SET writer_host_id=?, writer_workspace_path=?, writer_environment_id=?, updated_at=?
    WHERE id=? AND writer_host_id IS NULL AND writer_workspace_path IS NULL AND writer_environment_id IS NULL
      AND state IN ('pending','running')`)
    .run(input.hostId, input.workspacePath, input.environmentId, Date.now(), input.runId);
  return result.changes === 1;
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

export function writerWorkspaceForPmInstructions(
  run: { writer_workspace_path: string | null } | undefined,
  configPath: string | null | undefined,
): string | null {
  return run?.writer_workspace_path ?? configPath ?? null;
}
