import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { LanePilotDatabase } from "../../storage";
import { collectOwnerWaiting } from "../items";
import { ackDigest, loadPushConfig, planDigest, savePushConfig } from "../push";

/** What waits for the owner (screen, hub script): a read, the digest of new items for Telegram, its acknowledgement and the push settings. */
export function ownerWaitingRpc(db: LanePilotDatabase) {
  return {
    owner_waiting: async () => collectOwnerWaiting(db),
    owner_waiting_digest: async () => planDigest(db),
    owner_waiting_ack: async ({ keys }) => ({ acknowledged: ackDigest(db, keys) }),
    owner_waiting_config: async ({ patch }) => (patch ? savePushConfig(db, patch) : loadPushConfig(db)),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "owner_waiting" | "owner_waiting_digest" | "owner_waiting_ack" | "owner_waiting_config">;
}
