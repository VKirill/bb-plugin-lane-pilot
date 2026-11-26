import { lpChannel, type LpRealtimeKind } from "@lane-pilot/ui-kit/realtime-channel";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Bursts of changes reach the screens as one signal per this window. */
export const REALTIME_WINDOW_MS = 250;

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
