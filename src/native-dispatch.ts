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
import { bindNativeLaneRun } from "./native-run";

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

export async function handleNativeDispatch(
  bb: BbPluginApi,
  host: HostClient,
  ctx: {
    thread: { id: string };
    project: { id: string };
    host?: { id?: string } | null;
    environment?: { path?: string | null; id?: string | null } | null;
    requestedExecution: { providerId: string };
    input: { blocks?: unknown };
  },
  db: LanePilotDatabase,
): Promise<{ action: "proceed" } | { action: "reject"; message: string }> {
  try {
    const tokens = tokensFrom(ctx.input.blocks);
    if (tokens.length > 1) throw new Error("Select one Lane Pilot profile per chat.");
    const boundRaw = await bb.storage.kv.get<NativeSelection>(`native-thread:${ctx.thread.id}`);
    const bound = boundRaw ? nativeSelectionSchema.parse(boundRaw) : null;
    if (!tokens.length && !bound) return { action: "proceed" };
    if (ctx.requestedExecution.providerId !== "claude-code") {
      throw new Error("Lane Pilot native profile needs Claude Code. Switch the composer provider back, or start without the Lane mention.");
    }
    if (tokens.length && bound && bound.token !== tokens[0]) {
      throw new Error("The Lane Pilot profile is fixed for this chat. Start a new chat to choose another.");
    }
    let selected = bound;
    if (tokens.length) {
      const candidate = await bb.storage.kv.get<NativeSelection>(`native-selection:${tokens[0]}`);
      if (!candidate) throw new Error("Lane Pilot selection is missing. Choose the profile again.");
      selected = nativeSelectionSchema.parse(candidate);
    }
    if (!selected) return { action: "proceed" };
    if (selected.projectId !== ctx.project.id) {
      throw new Error("The Lane Pilot profile belongs to a different project.");
    }
    const collision = await probeCliAgentsCollision(bb, {
      projectId: ctx.project.id,
      threadId: ctx.thread.id,
      hostId: ctx.host?.id,
      providerId: ctx.requestedExecution.providerId,
      messageValue: ctx.input.blocks,
    });
    if (collision) throw new Error(collisionMessage(collision));
    const hostId = ctx.host?.id;
    const path = ctx.environment?.path;
    if (!hostId || !path) {
      throw new Error("Native send needs the real host and workspace path. Lane Pilot does not invent them.");
    }
    await bindNativeLaneRun({
      bb,
      db,
      threadId: ctx.thread.id,
      projectId: ctx.project.id,
      hostId,
      workspacePath: path,
      environmentId: ctx.environment?.id,
    });
    const prepared = await host.call("prepareNativeClaude", {
      cwd: path,
      agentId: selected.agentId,
      agentsJson: selected.agentsJson,
    }, { hostId }) as {
      env: ExperimentalPluginProviderEnvEntry[];
      agentId: string;
    };
    await bb.storage.kv.set(`native-thread:${ctx.thread.id}`, selected);
    await bb.storage.kv.set(`native-env:${ctx.thread.id}`, prepared.env);
    await bb.storage.kv.set(`native-agent-type:${ctx.thread.id}`, prepared.agentId);
    return { action: "proceed" };
  } catch (error) {
    return { action: "reject", message: `Lane Pilot: ${(error as Error).message}` };
  }
}

export async function nativeContributedEnv(
  bb: BbPluginApi,
  ctx: { threadId: string; hostId: string },
): Promise<ExperimentalPluginProviderEnvEntry[]> {
  const selected = await bb.storage.kv.get<NativeSelection>(`native-thread:${ctx.threadId}`);
  if (!selected) return [];
  return (await bb.storage.kv.get<ExperimentalPluginProviderEnvEntry[]>(`native-env:${ctx.threadId}`)) ?? [];
}
