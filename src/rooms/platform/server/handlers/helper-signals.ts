import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { attemptRunRef, hasRunForPmThread, onAttemptChanged, type LanePilotDatabase } from "../../../storage";
import { invalidateRpcTags, type Realtime } from "../services/realtime";

/** Thread events that change what the helper squares next to the agent badge show. */
const HELPER_EVENTS = ["thread.created", "thread.active", "thread.idle", "thread.failed", "thread.archived", "thread.unarchived", "thread.deleted"] as const;

type ThreadEvents = { on?: (event: string, handler: (payload: { thread?: { id?: string; projectId?: string; parentThreadId?: string | null } }) => void) => void };

/**
 * Wires the sources of «helpers» changes: BB thread events of a PM chat's children, and Lane Pilot's own attempt
 * states (a queued task has no thread yet). Rules call `notify` where they write.
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
