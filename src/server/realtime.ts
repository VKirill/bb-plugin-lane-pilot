import { onAttemptChanged } from "../rooms/storage/database";
import { lpChannel, type LpRealtimeKind } from "@lane-pilot/ui-kit/realtime-channel";
import type { LanePilotDatabase } from "../rooms/storage/database";
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

type ThreadEvents = { on?: (event: string, handler: (payload: { thread?: { projectId?: string; parentThreadId?: string | null } }) => void) => void };

/**
 * Wires the sources of «helpers» changes: BB thread events of a PM chat's children, and Lane Pilot's own attempt
 * states (a queued task has no thread yet). Council and rules call `notify` where they write.
 */
export function mountHelperSignals(bb: BbPluginApi, db: LanePilotDatabase, realtime: Realtime): () => void {
  const pmThreads = new Set<string>();
  const isPmThread = (threadId: string) => {
    if (pmThreads.has(threadId)) return true;
    const known = Boolean(db.prepare("SELECT 1 FROM lane_pilot_run WHERE pm_thread_id=? LIMIT 1").get(threadId));
    if (known) pmThreads.add(threadId);
    return known;
  };
  const events = (bb as unknown as { events?: ThreadEvents }).events;
  for (const event of HELPER_EVENTS) {
    events?.on?.(event, ({ thread }) => {
      const parent = thread?.parentThreadId;
      if (parent && thread?.projectId && isPmThread(parent)) realtime.notify(thread.projectId, "helpers", parent);
    });
  }
  return onAttemptChanged((attemptId) => {
    const row = db.prepare("SELECT r.project_id, r.pm_thread_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.id=?")
      .get(attemptId) as { project_id: string; pm_thread_id: string | null } | undefined;
    if (row) realtime.notify(row.project_id, "helpers", row.pm_thread_id ?? undefined);
  });
}
