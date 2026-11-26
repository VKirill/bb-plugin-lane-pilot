import { z } from "zod";
import type { ServerCore } from "../../../contracts/server";
import type { OwnerItemSweep } from "./owner-items-service";
import { ackDigest, planBellNotice } from "./owner-push-service";

export async function sendOwnerBellNotice(
  ctx: ServerCore,
  sweeps: readonly OwnerItemSweep[],
  now: number,
  options: { bypassDailyCap?: boolean; includeLater?: boolean } = {},
): Promise<{ sent: boolean; reason: string | null; keys: string[]; count: number }> {
  let notice: ReturnType<typeof planBellNotice>;
  try {
    notice = planBellNotice(ctx.db, now, sweeps, options);
  } catch (cause) {
    ctx.log(`owner bell: planning failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    return { sent: false, reason: "plan_error", keys: [], count: 0 };
  }
  if (!notice.send) return { sent: false, reason: notice.reason, keys: [], count: 0 };
  const callRpc = (ctx.bb.sdk as { plugins?: { callRpc?: (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown> }) => Promise<unknown> } }).plugins?.callRpc;
  if (!callRpc) return { sent: false, reason: "no_rpc", keys: [], count: 0 };
  try {
    await callRpc({ pluginId: "push-notifications", method: "notifications.send", input: { title: notice.title, text: notice.text }, outputSchema: z.unknown() });
  } catch (cause) {
    ctx.log(`owner bell: not sent (${cause instanceof Error ? cause.message : String(cause)}); the next event retries`);
    return { sent: false, reason: "send_failed", keys: [], count: 0 };
  }
  // The notice went out: a mark that cannot be written is said, never a reason to repeat the same notice in silence.
  try {
    ackDigest(ctx.db, notice.keys, now);
  } catch (cause) {
    ctx.log(`owner bell: sent, but the marks were not written: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { sent: true, reason: null, keys: notice.keys, count: notice.keys.length };
}
