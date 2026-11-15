import { attemptRunRef, hasRunForPmThread, onAttemptChanged } from "../../storage";
import { lpChannel, type LpRealtimeKind } from "@lane-pilot/ui-kit/realtime-channel";
import type { LanePilotDatabase } from "../../storage";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Bursts of changes (a council turn writes several rows) reach the screens as one signal per this window. */
export const REALTIME_WINDOW_MS = 250;

/** Thread events that change what the helper squares next to the agent badge show. */
const HELPER_EVENTS = ["thread.created", "thread.active", "thread.idle", "thread.failed", "thread.archived", "thread.unarchived", "thread.deleted"] as const;

export type Realtime = { notify: (projectId: string, kind: LpRealtimeKind, threadId?: string, id?: string) => void };

type RealtimeHost = { realtime?: { publish?: (channel: string, payload: unknown) => void } };

/**
 * Tells the open screens that something they show changed, so they re-read instead of polling every few seconds.
 * BB sends a plugin signal to every connected client and keeps nothing: the payload only says what to re-read.
 * A BB without `bb.realtime` (older core) turns this off and the screens fall back to their slow poll.
 */
export function createRealtime(bb: BbPluginApi, log: (message: string) => void): Realtime & { dispose: () => void } {
  const pending = new Map<string, { projectId: string; kind: LpRealtimeKind; threadId?: string; runId?: string; draftId?: string }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let warned = false;
  const publish = (channel: string, payload: unknown) => {
    try { (bb as unknown as RealtimeHost).realtime?.publish?.(channel, payload); }
    catch (cause) {
      if (!warned) { warned = true; log(`Lane Pilot realtime publish failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
  };
  const flush = () => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    for (const row of batch) publish(lpChannel(row.projectId), { kind: row.kind, ...(row.threadId ? { threadId: row.threadId } : {}), ...(row.runId ? { runId: row.runId } : {}), ...(row.draftId ? { draftId: row.draftId } : {}) });
  };
  return {
    // The fourth argument names the thing that changed: a run for `workflow`, a draft for `workflow-draft`.
    notify(projectId, kind, threadId, id) {
      if (!projectId || typeof (bb as unknown as RealtimeHost).realtime?.publish !== "function") return;
      const runId = kind === "workflow" ? id : undefined;
      const draftId = kind === "workflow-draft" ? id : undefined;
      pending.set(`${projectId}|${kind}|${threadId ?? ""}|${id ?? ""}`, { projectId, kind, ...(threadId ? { threadId } : {}), ...(runId ? { runId } : {}), ...(draftId ? { draftId } : {}) });
      if (!timer) { timer = setTimeout(flush, REALTIME_WINDOW_MS); timer.unref?.(); }
    },
    dispose() { if (timer) clearTimeout(timer); timer = null; pending.clear(); },
  };
}

/** Marks watched RPC reads stale for the SDK's query cache; a BB without experimental_invalidate ignores it and the screens keep their poll. */
export function invalidateRpcTags(bb: BbPluginApi, tags: readonly string[]): void {
  try { (bb.rpc as { experimental_invalidate?: (tags: readonly string[]) => void }).experimental_invalidate?.(tags); }
  catch { /* an older BB has no invalidate; the poll is the fallback */ }
}

type ThreadEvents = { on?: (event: string, handler: (payload: { thread?: { id?: string; projectId?: string; parentThreadId?: string | null } }) => void) => void };

/**
 * Wires the sources of «helpers» changes: BB thread events of a PM chat's children, and Lane Pilot's own attempt
 * states (a queued task has no thread yet). Council and rules call `notify` where they write.
 */
export function mountHelperSignals(bb: BbPluginApi, db: LanePilotDatabase, realtime: Realtime): () => void {
  const pmThreads = new Set<string>();
  const isPmThread = (threadId: string) => {
    if (pmThreads.has(threadId)) return true;
    const known = hasRunForPmThread(db, threadId);
    if (known) pmThreads.add(threadId);
    return known;
  };
  // The same entities the custom channel announces, marked stale for the SDK's watched reads
  // (ui-query-contract tags `helpers:<pmThread>` / `task-board:<project|all>` / `thread-live:<thread>` /
  // `work-graph` / `money_status`). A BB without experimental_invalidate ignores this and the screens keep their poll.
  const invalidate = (tags: readonly string[]) => invalidateRpcTags(bb, tags);
  const events = (bb as unknown as { events?: ThreadEvents }).events;
  for (const event of HELPER_EVENTS) {
    events?.on?.(event, ({ thread }) => {
      const parent = thread?.parentThreadId;
      if (thread?.id) invalidate([`thread-live:${thread.id}`]);
      if (parent && thread?.projectId && isPmThread(parent)) {
        realtime.notify(thread.projectId, "helpers", parent);
        invalidate([`helpers:${parent}`]);
      }
    });
  }
  return onAttemptChanged(db, (attemptId) => {
    const row = attemptRunRef(db, attemptId);
    if (!row) return;
    realtime.notify(row.project_id, "helpers", row.pm_thread_id ?? undefined);
    invalidate([
      `task-board:${row.project_id}`, "task-board:all",
      // Every watched read an attempt write can move: the board and log tail (task-board tags), the stage
      // strips and task graph (work-graph), the spend read (money_status), the thread's own live card.
      "work-graph", "money_status",
      ...(row.pm_thread_id ? [`helpers:${row.pm_thread_id}`] : []),
      ...(row.thread_id ? [`thread-live:${row.thread_id}`] : []),
    ]);
  });
}
