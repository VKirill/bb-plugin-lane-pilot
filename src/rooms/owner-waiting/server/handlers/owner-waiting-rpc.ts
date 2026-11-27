import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import type { LanePilotDatabase } from "../../../storage";
import { callReason, type CallReason } from "../../models/owner-item";
import { closeOwnerItem, collectOwnerWaiting, hasOpenAttempts, type OwnerItemSweep } from "../services/owner-items-service";
import { ackDigest, loadPushConfig, planDigest, savePushConfig } from "../services/owner-push-service";

// The webhook poster is injected (relay/server/outbound.postEvent): importing relay here would close a
// room cycle owner-waiting -> relay -> verification -> owner-waiting.
type PostEvent = (db: LanePilotDatabase, projectId: string, input: Partial<Record<string, unknown>>, log: (message: string) => void) => Promise<boolean>;

const WAITING_PHRASE: Record<CallReason, string> = {
  decision: "A decision is waiting for the owner",
  blocked: "Work is blocked and waits for the owner",
  red: "Something is red and waits for the owner",
  term: "A term is ending and waits for the owner",
};

/** What waits for the owner (screen, hub script): a read, the digest of new items for Telegram, its acknowledgement and the push settings. */
export function ownerWaitingRpc(
  db: LanePilotDatabase,
  sweeps: readonly OwnerItemSweep[] = [],
  log: (message: string) => void = () => undefined,
  postEvent: PostEvent = async () => false,
  invalidate: () => void = () => undefined,
  debugLog: (message: string) => void = () => undefined,
) {
  return {
    owner_waiting: async () => collectOwnerWaiting(db, Date.now(), sweeps, { log: debugLog }),
    // The webhook is the one sanctioned outbound path (SMA k_lib_notify): every wake item the digest sends also posts
    // owner.waiting there, and the pass ends with one pulse event; a project without events.webhook_url posts nothing.
    owner_waiting_digest: async () => {
      const now = Date.now();
      const digest = planDigest(db, now, sweeps);
      if (!digest.send) return digest;
      const items = collectOwnerWaiting(db, now, sweeps).items.filter((item) => digest.keys.includes(item.key));
      const projects = new Set<string>();
      for (const item of items) {
        if (!item.projectId) continue;
        projects.add(item.projectId);
        // Only the item's kind, source and key and a fixed phrase leave the machine, never `what` or `why` (the nine
        // fields have no place for them, so source rides in runId and key in taskId).
        void postEvent(db, item.projectId, { event: "owner.waiting", title: WAITING_PHRASE[callReason(item.kind)], kind: item.kind, runId: item.source, taskId: item.key, state: "waiting" }, log)
          .catch((cause: unknown) => log(`owner.waiting event: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
      const state = items.length ? "waiting" : hasOpenAttempts(db) ? "working" : "idle";
      for (const projectId of projects) {
        void postEvent(db, projectId, { event: "pulse", state, kind: "pulse" }, log)
          .catch((cause: unknown) => log(`pulse event: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
      return digest;
    },
    owner_waiting_ack: async ({ keys }) => { const out = { acknowledged: ackDigest(db, keys) }; invalidate(); return out; },
    owner_waiting_close: async ({ key }) => { const out = { closed: closeOwnerItem(db, key, "screen") }; invalidate(); return out; },
    owner_waiting_config: async ({ patch }) => {
      if (!patch) return loadPushConfig(db);
      const normalized: Record<string, string | undefined> = {};
      for (const [rawKey, rawVal] of Object.entries(patch)) {
        const key = rawKey === "decisionCap" ? "decision_cap" : rawKey;
        normalized[key] = typeof rawVal === "boolean" ? (rawVal ? "on" : "off") : rawVal === undefined ? undefined : String(rawVal);
      }
      const out = savePushConfig(db, normalized);
      invalidate();
      return out;
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "owner_waiting" | "owner_waiting_digest" | "owner_waiting_ack" | "owner_waiting_close" | "owner_waiting_config">;
}
