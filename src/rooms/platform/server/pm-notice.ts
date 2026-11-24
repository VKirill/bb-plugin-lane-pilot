import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sendServiceMessage } from "./service-message";

/** How recently a PM chat must have moved for an informational notice to be worth sending into it. */
export const PM_NOTICE_FRESH_MS = 30 * 60_000;

/**
 * An informational notice to a PM chat, sent only while that chat is warm: a message into a chat idle for hours
 * starts a turn that rereads its whole context with the prompt cache gone (2026-10-30: the stale-run sweep of 0.1.390
 * woke 44 PM chats idle for days). A cold chat gets nothing; the fact stays in the run records and logs.
 */
export async function sendPmNotice(bb: Pick<BbPluginApi, "sdk">, threadId: string, text: string, now = Date.now(), freshMs = PM_NOTICE_FRESH_MS): Promise<boolean> {
  // an unreadable thread counts as cold: no notice is sent
  const thread = await Promise.resolve().then(() => bb.sdk.threads.get({ threadId })).catch(() => null) as { updatedAt?: unknown } | null;
  const updatedAt = Number(thread?.updatedAt ?? 0);
  if (!thread || !Number.isFinite(updatedAt) || now - updatedAt > freshMs) return false;
  // A refused send (the chat archived meanwhile, a transport error) is no delivery: the caller falls back to the owner's list
  // (Astra F-005: the second pilot used to report «owner told» on a chat that only looked warm).
  try { await sendServiceMessage(bb as never, { threadId, text }); return true; } catch { return false; }
}

const activeWorkflowWaiters = new Map<string, number>();
const readWorkflowRuns = new Map<string, number>();
const activeWriterWaiters = new Map<string, number>();

/** Marks a PM chat as actively inside `lane_pilot_wait_writer` so mid-flight background alerts do not queue duplicate turns. */
export function beginWriterWait(pmThreadId: string): () => void {
  activeWriterWaiters.set(pmThreadId, (activeWriterWaiters.get(pmThreadId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const next = (activeWriterWaiters.get(pmThreadId) ?? 1) - 1;
    if (next <= 0) activeWriterWaiters.delete(pmThreadId);
    else activeWriterWaiters.set(pmThreadId, next);
  };
}

/** True while a PM chat is synchronously awaiting `lane_pilot_wait_writer`. */
export function isWriterWaitActive(pmThreadId: string | null | undefined): boolean {
  return Boolean(pmThreadId && (activeWriterWaiters.get(pmThreadId) ?? 0) > 0);
}

const followedWorkflowRuns = new Map<string, number>();

/** Marks a workflow run as actively awaited by a synchronous PM tool (`wait_specialist`, `wait_errand`, `wait_scout`) so its completion does not also queue a duplicate PM notice. */
export function beginWorkflowWait(workflowRunId: string, now = Date.now()): () => void {
  noteWorkflowFollowedByPm(workflowRunId, now);
  activeWorkflowWaiters.set(workflowRunId, (activeWorkflowWaiters.get(workflowRunId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const next = (activeWorkflowWaiters.get(workflowRunId) ?? 1) - 1;
    if (next <= 0) activeWorkflowWaiters.delete(workflowRunId);
    else activeWorkflowWaiters.set(workflowRunId, next);
  };
}

/** Marks a terminal workflow run as already read directly by its PM tool so a late background notice does not wake the PM again. */
export function noteWorkflowReadByPm(workflowRunId: string, now = Date.now()): void {
  for (const [id, at] of readWorkflowRuns) if (now - at > 3_600_000) readWorkflowRuns.delete(id);
  readWorkflowRuns.set(workflowRunId, now);
}

/** True when a synchronous PM wait tool is actively waiting on `workflowRunId` or already returned its terminal result. */
export function isWorkflowNoticeSuppressed(workflowRunId: string, now = Date.now()): boolean {
  if ((activeWorkflowWaiters.get(workflowRunId) ?? 0) > 0) return true;
  const at = readWorkflowRuns.get(workflowRunId);
  return at !== undefined && now - at <= 3_600_000;
}

/** Marks a run the PM is polling (a wait tool or `lane_pilot_workflow_status` saw it still running): see `isWorkflowFollowed`. */
export function noteWorkflowFollowedByPm(workflowRunId: string, now = Date.now()): void {
  for (const [id, at] of followedWorkflowRuns) if (now - at > 3_600_000) followedWorkflowRuns.delete(id);
  followedWorkflowRuns.set(workflowRunId, now);
}

/**
 * True when the PM has polled `workflowRunId` at least once: the PM is following the run and will most likely read its end
 * itself. A run that ends in the gap between two wait calls (live 2026-11-24: the first `wait_errand` hit its 240 s limit 0.4 s before
 * the run ended, the second came 4 s later) is not «actively awaited» at that instant, yet a notice would duplicate what the PM reads next.
 */
export function isWorkflowFollowed(workflowRunId: string, now = Date.now()): boolean {
  const at = followedWorkflowRuns.get(workflowRunId);
  return at !== undefined && now - at <= 3_600_000;
}

/**
 * Detaches the PM tool call running now (VK core `bb.agents.experimental_vkDetachToolCall`): the PM gets `text` at once and
 * the value the tool's `execute` later returns reaches the chat as BB's own delivered tool result, the path
 * `lane_pilot_ask_owner`'s form already takes. False without the core function (the tool then answers as before and the
 * PM waits with its wait tool) or when BB refuses; a throwing double counts as absent.
 */
export function detachToolCall(bb: { agents: object }, text: string): boolean {
  const detach = (bb.agents as { experimental_vkDetachToolCall?: (text?: string) => boolean }).experimental_vkDetachToolCall;
  if (typeof detach !== "function") return false;
  try { return detach.call(bb.agents, text) === true; } catch { return false; }
}

/** How long a detached helper tool keeps following its run; past it the PM gets «running» and its wait tool still works. */
export const DETACHED_WAIT_SEC = 6 * 3600;

/** Detaches a helper start (errand, specialist, scout): the PM is told the result comes by itself, never to poll `waitTool`. */
export function detachHelperStart(bb: { agents: object }, started: string, waitTool: string): boolean {
  return detachToolCall(bb, `${started} Its result arrives by itself as this tool's delivered result: do not call ${waitTool}; continue other work or end your turn.`);
}
