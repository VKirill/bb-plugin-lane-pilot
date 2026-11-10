import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { LanePilotDatabase } from "../../storage";
import { listOpenAttempts } from "../../storage";
import { closeOwnerItem, collectOwnerWaiting, type LearningItemsReader, type OwnerItemSweep } from "../items";
import { ackDigest, loadPushConfig, planDigest, savePushConfig } from "../push";
import { postEvent } from "../../relay/server";

/** What waits for the owner (screen, hub script): a read, the digest of new items for Telegram, its acknowledgement and the push settings. */
export function ownerWaitingRpc(db: LanePilotDatabase, sweeps: readonly OwnerItemSweep[] = [], learningReader?: LearningItemsReader, log: (message: string) => void = () => undefined) {
  return {
    owner_waiting: async () => collectOwnerWaiting(db, Date.now(), sweeps, undefined, learningReader),
    // The webhook is the one sanctioned outbound path (SMA k_lib_notify): every wake item the digest sends also posts
    // owner.waiting there, and the pass ends with one pulse event; a project without events.webhook_url posts nothing.
    owner_waiting_digest: async () => {
      const now = Date.now();
      const digest = planDigest(db, now, sweeps, learningReader);
      if (!digest.send) return digest;
      const items = collectOwnerWaiting(db, now, sweeps, undefined, learningReader).items.filter((item) => digest.keys.includes(item.key));
      const projects = new Set<string>();
      for (const item of items) {
        if (!item.projectId) continue;
        projects.add(item.projectId);
        void postEvent(db, item.projectId, { event: "owner.waiting", title: item.what, kind: item.kind, state: "waiting" }, log);
      }
      const state = items.length ? "waiting" : listOpenAttempts(db).length ? "working" : "idle";
      for (const projectId of projects) void postEvent(db, projectId, { event: "pulse", state, kind: "pulse" }, log);
      return digest;
    },
    owner_waiting_ack: async ({ keys }) => ({ acknowledged: ackDigest(db, keys) }),
    owner_waiting_close: async ({ key }) => ({ closed: closeOwnerItem(db, key, "screen") }),
    owner_waiting_config: async ({ patch }) => (patch ? savePushConfig(db, patch) : loadPushConfig(db)),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "owner_waiting" | "owner_waiting_digest" | "owner_waiting_ack" | "owner_waiting_close" | "owner_waiting_config">;
}
