import type { BbPluginApi, ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { LanePilotDatabase } from "./database";
import {
  CLI_AGENTS_PLUGIN_ID,
  classifyCliAgentsCollision,
  cliAgentsSelectionNullableSchema,
  collisionMessage,
  isMissingPluginRpc,
  nativeSelectionMarker,
  nativeSelectionSchema,
  tokensFrom,
  type NativeSelection,
} from "./native-session";
import {
  attachNativeLaneClaim,
  claimNativeLaneRun,
  finalizeNativeLaneBinding,
  inspectDispatchPlacement,
  resolveNativeDispatchWorkspace,
} from "./native-run";

type HostClient = {
  call: (method: string, input: unknown, opts: { hostId: string }) => Promise<unknown>;
};

async function callCliAgentsRpc<T>(
  bb: BbPluginApi,
  method: "pending" | "thread",
  input: Record<string, unknown>,
  outputSchema: z.ZodType<T>,
): Promise<T | undefined> {
  const plugins = (bb.sdk as { plugins?: {
    experimental_discoverRpc?: (q: { pluginId: string; method: string }) => Promise<unknown[]>;
    callRpc: (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<T> }) => Promise<T>;
  } }).plugins;
  if (!plugins?.callRpc) return undefined;
  try {
    const listed = await plugins.experimental_discoverRpc?.({ pluginId: CLI_AGENTS_PLUGIN_ID, method });
    if (Array.isArray(listed) && listed.length === 0) return undefined;
  } catch (error) {
    if (!isMissingPluginRpc(error)) throw error;
    return undefined;
  }
  try {
    return await plugins.callRpc({
      pluginId: CLI_AGENTS_PLUGIN_ID,
      method,
      input,
      outputSchema,
    });
  } catch (error) {
    if (isMissingPluginRpc(error)) return undefined;
    throw error;
  }
}

export async function probeCliAgentsCollision(bb: BbPluginApi, input: {
  projectId: string;
  threadId: string;
  hostId: string | undefined;
  providerId: string;
  messageValue: unknown;
}): Promise<ReturnType<typeof classifyCliAgentsCollision>> {
  const pending = await callCliAgentsRpc(
    bb,
    "pending",
    { projectId: input.projectId, providerId: input.providerId },
    cliAgentsSelectionNullableSchema,
  ) ?? null;
  const thread = await callCliAgentsRpc(
    bb,
    "thread",
    { threadId: input.threadId },
    cliAgentsSelectionNullableSchema,
  ) ?? null;
  return classifyCliAgentsCollision({
    messageValue: input.messageValue,
    pending,
    thread,
    hostId: input.hostId,
    providerId: input.providerId,
  });
}

export async function prepareNativeSessionRecord(input: {
  projectId: string;
  agentId: string;
  profileMode: NativeSelection["profileMode"];
  agentsJson: string | null;
  sourceHash: string | null;
}): Promise<NativeSelection> {
  const { randomUUID } = await import("node:crypto");
  return nativeSelectionSchema.parse({
    token: randomUUID(),
    projectId: input.projectId,
    agentId: input.agentId,
    profileMode: input.profileMode,
    agentsJson: input.agentsJson,
    sourceHash: input.sourceHash,
    createdAt: Date.now(),
  });
}

export function mentionContext(selection: NativeSelection): string {
  return `${nativeSelectionMarker(selection.token)}\nNative Lane profile ${selection.agentId} (${selection.profileMode}).`;
}

function placementTrace(ctx: {
  host?: { id?: string } | null;
  environment?: { id?: string | null; path?: string | null; hostId?: string | null } | null;
  environmentIntent?: unknown;
}): Record<string, string | number | boolean | null> {
  const placement = inspectDispatchPlacement(ctx);
  return {
    intent: placement.kind,
    envProvider: placement.providerId,
    machine: placement.machineType,
    host: placement.hostId,
    pathPresent: placement.pathPresent,
    inputKeys: placement.inputKeys,
  };
}

export function traceNativeDispatch(
  log: { warn: (message: string) => void },
  stage: string,
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value === null ? "null" : String(value)}`);
  log.warn(`native-trace ${stage} ${parts.join(" ")}`);
}

export async function handleNativeDispatch(
  bb: BbPluginApi,
  host: HostClient,
  ctx: {
    thread: { id: string };
    project: { id: string };
    host?: { id?: string } | null;
    environment?: { path?: string | null; id?: string | null; hostId?: string | null } | null;
    environmentIntent?: unknown;
    requestedExecution: { providerId: string };
    input: { blocks?: unknown };
    experimental_submission?: { pluginId: string; data: unknown } | null;
  },
  db: LanePilotDatabase,
): Promise<{ action: "proceed" } | { action: "reject"; message: string }> {
  const hidden = ctx.experimental_submission?.pluginId === "lane-pilot"
    ? z.object({ token: z.string().uuid() }).safeParse(ctx.experimental_submission.data)
    : null;
  if (hidden && !hidden.success) return { action: "reject", message: "Lane Pilot: Invalid profile selection. Enable Lane Pilot again." };
  const tokens = [...new Set([
    ...tokensFrom(ctx.input.blocks),
    ...(hidden?.success ? [hidden.data.token] : []),
  ])];
  const base = {
    thread: ctx.thread.id,
    project: ctx.project.id,
    token: tokens[0] ?? null,
    tokens: tokens.length,
    provider: ctx.requestedExecution.providerId,
    env: ctx.environment?.id ? "attached" : "null",
    ...placementTrace(ctx),
  };
  const reject = (
    reason: string,
    message: string,
    extra?: Record<string, string | number | boolean | null>,
  ) => {
    traceNativeDispatch(bb.log, "reject", { ...base, reason, ...extra });
    return { action: "reject" as const, message: `Lane Pilot: ${message}` };
  };
  try {
    traceNativeDispatch(bb.log, "dispatch.start", base);
    if (tokens.length > 1) {
      return reject("multiple_tokens", "Select one Lane Pilot profile per chat.");
    }
    const boundRaw = await bb.storage.kv.get<NativeSelection>(`native-thread:${ctx.thread.id}`);
    const bound = boundRaw ? nativeSelectionSchema.parse(boundRaw) : null;
    if (!tokens.length && !bound) {
      traceNativeDispatch(bb.log, "dispatch.skip", { ...base, reason: "no_token_or_bound" });
      return { action: "proceed" };
    }
    if (ctx.requestedExecution.providerId !== "claude-code") {
      return reject(
        "provider_not_claude_code",
        "Lane Pilot native profile needs Claude Code. Switch the composer provider back, or start without the Lane mention.",
      );
    }
    if (tokens.length && bound && bound.token !== tokens[0]) {
      return reject(
        "bound_token_mismatch",
        "The Lane Pilot profile is fixed for this chat. Start a new chat to choose another.",
        { bound: bound.token },
      );
    }
    let selected = bound;
    if (tokens.length) {
      const candidate = await bb.storage.kv.get<NativeSelection>(`native-selection:${tokens[0]}`);
      if (!candidate) {
        return reject("selection_missing", "Lane Pilot selection is missing. Choose the profile again.");
      }
      selected = nativeSelectionSchema.parse(candidate);
    }
    if (!selected) {
      traceNativeDispatch(bb.log, "dispatch.skip", { ...base, reason: "no_selection" });
      return { action: "proceed" };
    }
    if (selected.projectId !== ctx.project.id) {
      return reject(
        "project_mismatch",
        "The Lane Pilot profile belongs to a different project.",
        { tokenProject: selected.projectId },
      );
    }
    let workspace;
    try {
      workspace = resolveNativeDispatchWorkspace(ctx);
    } catch (error) {
      return reject("workspace", (error as Error).message);
    }
    const collision = await probeCliAgentsCollision(bb, {
      projectId: ctx.project.id,
      threadId: ctx.thread.id,
      hostId: workspace.hostId ?? undefined,
      providerId: ctx.requestedExecution.providerId,
      messageValue: ctx.input.blocks,
    });
    if (collision) {
      return reject("cli_agents_collision", collisionMessage(collision), { detail: collision });
    }
    const claimed = claimNativeLaneRun({
      db,
      threadId: ctx.thread.id,
      projectId: ctx.project.id,
    });
    if (claimed.created) {
      await attachNativeLaneClaim({
        bb,
        db,
        threadId: ctx.thread.id,
        projectId: ctx.project.id,
        runId: claimed.runId,
      });
    }
    if (workspace.phase === "pending") {
      if (!workspace.hostId) {
        return reject("workspace", "Native send needs the selected project-checkout host and path. Lane Pilot does not invent them.");
      }
      traceNativeDispatch(bb.log, "host.call", { ...base, reason: "prepareNativeClaude", host: workspace.hostId, phase: "host-only" });
      const prepared = await host.call("prepareNativeClaude", {
        agentId: selected.agentId,
        agentsJson: selected.agentsJson,
      }, { hostId: workspace.hostId }) as {
        env: ExperimentalPluginProviderEnvEntry[];
        agentId: string;
      };
      await bb.storage.kv.set(`native-thread:${ctx.thread.id}`, selected);
      await bb.storage.kv.set(`native-env:${ctx.thread.id}`, prepared.env);
      await bb.storage.kv.set(`native-agent-type:${ctx.thread.id}`, prepared.agentId);
      traceNativeDispatch(bb.log, "dispatch.proceed", { ...base, reason: "workspace_pending" });
      return { action: "proceed" };
    }
    if (workspace.environmentId) {
      if (!finalizeNativeLaneBinding({
        db,
        runId: claimed.runId,
        hostId: workspace.hostId,
        workspacePath: workspace.workspacePath,
        environmentId: workspace.environmentId,
      })) {
        return reject(
          "environment_cas",
          "native environment CAS failed; run is no longer pending or already has a binding",
        );
      }
    }
    traceNativeDispatch(bb.log, "host.call", { ...base, reason: "prepareNativeClaude", host: workspace.hostId });
    const prepared = await host.call("prepareNativeClaude", {
      cwd: workspace.workspacePath,
      agentId: selected.agentId,
      agentsJson: selected.agentsJson,
    }, { hostId: workspace.hostId }) as {
      env: ExperimentalPluginProviderEnvEntry[];
      agentId: string;
    };
    await bb.storage.kv.set(`native-thread:${ctx.thread.id}`, selected);
    await bb.storage.kv.set(`native-env:${ctx.thread.id}`, prepared.env);
    await bb.storage.kv.set(`native-agent-type:${ctx.thread.id}`, prepared.agentId);
    traceNativeDispatch(bb.log, "dispatch.proceed", { ...base, reason: "ok" });
    return { action: "proceed" };
  } catch (error) {
    return reject("exception", (error as Error).message);
  }
}

export async function nativeContributedEnv(
  bb: BbPluginApi,
  host: HostClient,
  ctx: { threadId: string; hostId: string },
): Promise<ExperimentalPluginProviderEnvEntry[]> {
  try {
    const selected = await bb.storage.kv.get<NativeSelection>(`native-thread:${ctx.threadId}`);
    if (!selected) return [];
    const cached = await bb.storage.kv.get<ExperimentalPluginProviderEnvEntry[]>(`native-env:${ctx.threadId}`);
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId }).catch(() => null);
    const environmentId = thread && typeof thread.environmentId === "string" ? thread.environmentId.trim() : "";
    const environment = environmentId
      ? await bb.sdk.environments.get({ environmentId }).catch(() => null)
      : null;
    const path = environment && typeof environment.path === "string" ? environment.path.trim() : "";
    const envHost = environment && typeof environment.hostId === "string" && environment.hostId.trim()
      ? environment.hostId.trim()
      : ctx.hostId;
    if (path.startsWith("/") && envHost && (!ctx.hostId || envHost === ctx.hostId)) {
      try {
        traceNativeDispatch(bb.log, "host.call", {
          thread: ctx.threadId,
          token: selected.token,
          reason: "prepareNativeClaude",
          host: envHost,
          phase: "contributeEnv",
        });
        const prepared = await host.call("prepareNativeClaude", {
          cwd: path,
          agentId: selected.agentId,
          agentsJson: selected.agentsJson,
        }, { hostId: envHost }) as {
          env: ExperimentalPluginProviderEnvEntry[];
          agentId: string;
        };
        await bb.storage.kv.set(`native-env:${ctx.threadId}`, prepared.env);
        await bb.storage.kv.set(`native-agent-type:${ctx.threadId}`, prepared.agentId);
        return prepared.env;
      } catch {
        if (cached?.length) return cached;
      }
    }
    return cached?.length ? cached : [];
  } catch {
    return [];
  }
}
