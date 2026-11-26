export type ContractResult = { state: "created"; taskId: string } | { state: "failed"; reason: string };
export type TaskDraft = { id: string; runId: string | null; projectId: string; threadId: string | null; kind: "task" | "batch";
  contracts: unknown[]; objective: string | null; plan: string | null; state: "proposed" | "created" | "partial"; taskIds: string[];
  results: Array<ContractResult | null>; createdAt: number; updatedAt: number };
export type CreateOutcome = { state: "created" | "already_created" | "partial"; taskIds: string[]; runId: string | null; failed: Array<{ index: number; reason: string }>; results: Array<ContractResult | null> };

/** The bound of a batch, enforced here on the server (the tool schema's max is only the first line): contracts per draft and bytes of their JSON. */
export const MAX_DRAFT_CONTRACTS = 50;
export const MAX_DRAFT_BYTES = 1_000_000;
/** Drafts untouched for this long are deleted when a new one is proposed. */
export const DRAFT_KEEP_MS = 30 * 86_400_000;

/** A dispatch reply is a created task only when it names one; a rejection, a lint refusal or `ok:false` is a failure with its reason. */
export function settleReply(reply: Record<string, unknown>): ContractResult {
  const taskId = typeof reply.taskId === "string" ? reply.taskId.trim() : "";
  const bad = reply.ok === false || reply.state === "rejected" || reply.state === "validation_failed";
  if (taskId && !bad) return { state: "created", taskId };
  const error = reply.error as { code?: string; hint?: string } | undefined;
  const reason = [reply.reason, error?.hint, reply.hint, error?.code].find((part): part is string => typeof part === "string" && part.trim().length > 0) ?? `dispatch answered without a task (${String(reply.state ?? "no state")})`;
  return { state: "failed", reason: reason.slice(0, 600) };
}
