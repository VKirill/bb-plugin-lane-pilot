import { z } from "zod";

export * from "./native-agent-id";
import { nativeAgentCliId } from "./native-agent-id";

export const nativeSelectionMarker = (token: string) => `[lane-pilot-selection:${token}]`;

export const nativeSelectionSchema = z.object({
  token: z.string().uuid(),
  projectId: z.string().min(1),
  agentId: z.string().min(1).max(200),
  profileMode: z.enum(["installed", "session-override"]),
  agentsJson: z.string().max(200_000).nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  createdAt: z.number(),
  /** A PM's specialist thread: it works for this run and never opens a run of its own. */
  parentRunId: z.string().min(1).optional(),
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
