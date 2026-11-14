// Public API of owner-waiting/server: what other rooms import. Everything else in this room is private.
export { ownerWaitingRpc } from "./rpc";
export { loadPushConfig, readOwnerConfigKey, writeOwnerConfigKey } from "../push";
export { WAITING_USAGE, runWaitingCli } from "../cli";
export { planBellNotice } from "../push";

import { z } from "zod";
import { scheduleIsolated } from "../../platform/server";
import type { ServerCore } from "../../contracts/server";
import { ackDigest, planBellNotice } from "../push";
import type { LearningItemsReader, OwnerItemSweep } from "../items";

/** The bell «awaits a decision» (SMA m_ws_notify): every five minutes the new wake items become one browser notification
 * through the push-notifications plugin — a title and a count line, no item text; the announced keys are marked so a repeat
 * never goes out, quiet hours and owner_push.enabled apply, and a missing plugin or a failed send is logged (the next tick asks again).
 * On unless the owner stored `bell=off` (`bb lane-pilot waiting push-config bell=off`). An item the Telegram digest announced is skipped, and the first tick after an upgrade only marks what exists. */
export function mountOwnerBell(ctx: ServerCore, sweeps: readonly OwnerItemSweep[] = [], learningReader?: LearningItemsReader): void {
  scheduleIsolated(ctx.bb, "owner-bell", "*/5 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    let notice: ReturnType<typeof planBellNotice>;
    try { notice = planBellNotice(ctx.db, Date.now(), sweeps, learningReader); }
    catch (cause) { ctx.log(`owner bell: planning failed: ${cause instanceof Error ? cause.message : String(cause)}`); return; }
    if (!notice.send) return;
    const callRpc = (ctx.bb.sdk as { plugins?: { callRpc?: (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown> }) => Promise<unknown> } }).plugins?.callRpc;
    if (!callRpc) return;
    try { await callRpc({ pluginId: "push-notifications", method: "notifications.send", input: { title: notice.title, text: notice.text }, outputSchema: z.unknown() }); }
    catch (cause) { ctx.log(`owner bell: not sent (${cause instanceof Error ? cause.message : String(cause)}); the next tick tries again`); return; }
    // The notice went out: a mark that cannot be written is said, never a reason to send the same notice every five minutes in silence.
    try { ackDigest(ctx.db, notice.keys); }
    catch (cause) { ctx.log(`owner bell: sent, but the marks were not written: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }, { timeoutMs: 30_000 });
}
