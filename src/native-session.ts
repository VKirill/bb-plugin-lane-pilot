import { z } from "zod";

export const NATIVE_MENTION_PROVIDER = "lane-pilot";
export const CLI_AGENTS_PLUGIN_ID = "cli-agents";
export const DEFAULT_NATIVE_AGENT = "dev-orchestrator";
export const GUARD_PM_AGENTS = ["dev-orchestrator", "frontend-orchestrator", "marketing-orchestrator"] as const;

/** Claude `--agent` flag: short id. Runtime agentSetting is `plugin:short` (see live transcript). */
export function nativeAgentCliId(agentId: string): string {
  const trimmed = agentId.trim();
  if (!trimmed) throw new Error("native_agent_id_missing");
  const short = trimmed.includes(":") ? trimmed.slice(trimmed.lastIndexOf(":") + 1) : trimmed;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(short) || short.includes(":")) {
    throw new Error(`native_agent_id_invalid:${agentId}`);
  }
  return short;
}

export function nativeAgentSettingId(agentId: string, source?: string): string {
  const trimmed = agentId.trim();
  if (!trimmed) throw new Error("native_agent_id_missing");
  if (trimmed.includes(":")) return trimmed;
  const short = nativeAgentCliId(trimmed);
  if (source?.startsWith("plugin:")) {
    const plugin = source.slice("plugin:".length).trim();
    if (plugin) return `${plugin}:${short}`;
  }
  return short;
}

export const nativeSelectionMarker = (token: string) => `[lane-pilot-selection:${token}]`;

export const nativeSelectionSchema = z.object({
  token: z.string().uuid(),
  projectId: z.string().min(1),
  agentId: z.string().min(1).max(200),
  profileMode: z.enum(["installed", "session-override"]),
  agentsJson: z.string().max(200_000).nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  createdAt: z.number(),
}).strict();

export type NativeSelection = z.infer<typeof nativeSelectionSchema>;

export const cliAgentsSelectionSchema = z.object({
  projectId: z.string(),
  hostId: z.string(),
  providerId: z.string(),
  agentId: z.string(),
  token: z.string(),
}).passthrough();

export const cliAgentsSelectionNullableSchema = cliAgentsSelectionSchema.nullable();

export function tokensFrom(value: unknown): string[] {
  return [...new Set([...JSON.stringify(value).matchAll(/\[lane-pilot-selection:([0-9a-f-]{36})\]/g)].map((m) => m[1]!))];
}

export function hasCliAgentsMarker(value: unknown): boolean {
  return /\[cli-agents-selection:[0-9a-f-]{36}\]/.test(JSON.stringify(value));
}

export function cliAgentsPendingApplies(input: {
  pending: z.infer<typeof cliAgentsSelectionNullableSchema>;
  hostId: string | undefined;
  providerId: string;
}): boolean {
  const pending = input.pending;
  if (!pending || pending.providerId !== input.providerId) return false;
  return !pending.hostId || !input.hostId || pending.hostId === input.hostId;
}

export function isMissingPluginRpc(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /not stubbed|not installed|not found|unknown plugin|no plugin|method .* missing/i.test(text);
}

export type CliAgentsCollision = "pending" | "thread" | "mention";

export function classifyCliAgentsCollision(input: {
  messageValue: unknown;
  pending: z.infer<typeof cliAgentsSelectionNullableSchema>;
  thread: z.infer<typeof cliAgentsSelectionNullableSchema>;
  hostId: string | undefined;
  providerId: string;
}): CliAgentsCollision | null {
  if (hasCliAgentsMarker(input.messageValue)) return "mention";
  if (input.thread && input.thread.providerId === input.providerId) return "thread";
  if (cliAgentsPendingApplies({ pending: input.pending, hostId: input.hostId, providerId: input.providerId })) {
    return "pending";
  }
  return null;
}

export function collisionMessage(kind: CliAgentsCollision): string {
  if (kind === "mention") {
    return "CLI Agents already marked this send. Remove that Agent mention. Lane Pilot does not clear CLI Agents state.";
  }
  if (kind === "thread") {
    return "CLI Agents already bound this chat. Start a new chat without a CLI session agent. Lane Pilot does not clear that binding.";
  }
  return "CLI Agents has a project pending selection (no mention required). Clear it in CLI Agents. Lane Pilot does not delete pending:<project>:<provider>.";
}
