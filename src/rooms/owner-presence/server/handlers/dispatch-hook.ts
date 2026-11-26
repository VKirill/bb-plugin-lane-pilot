import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { laneOwnedMetadata } from "../../models/presence";
import { isOwnerPresenceBound, recordOwnerPresence } from "../services/presence-service";

/**
 * A user message in a thread Lane Pilot did not start marks that thread's provider. Agent sends, retries from another
 * thread, and any thread with a lane role or marker do not. (2026-10-29 claude-guard)
 */
export async function observeOwnerDispatch(bb: Pick<BbPluginApi, "sdk">, ctx: {
  initiator?: string | null;
  senderThreadId?: string | null;
  thread: { id: string };
  requestedExecution: { providerId: string };
  host?: { id?: string; name?: string | null } | null;
}): Promise<void> {
  if (!isOwnerPresenceBound() || ctx.initiator !== "user" || ctx.senderThreadId) return;
  const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: ctx.thread.id }).catch(() => null);
  if (laneOwnedMetadata(metadata)) return;
  const providerId = ctx.requestedExecution.providerId;
  if (!providerId) return;
  await recordOwnerPresence({
    providerId,
    at: Date.now(),
    hostId: ctx.host?.id || "bb",
    host: ctx.host?.name ?? null,
  }, { threadId: ctx.thread.id });
}
