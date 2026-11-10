// Public API of owner-waiting/server: what other rooms import. Everything else in this room is private.
export { ownerWaitingRpc } from "./rpc";
export { loadPushConfig } from "../push";
export { WAITING_USAGE, runWaitingCli } from "../cli";
export { planBellNotice } from "../push";

import { z } from "zod";
import { scheduleIsolated } from "../../platform/server";
import type { ServerCore } from "../../contracts/server";
import { ackDigest, planBellNotice } from "../push";
import type { LearningItemsReader, OwnerItemSweep } from "../items";

/** The bell «awaits a decision» (SMA m_ws_notify): every five minutes the new wake items become one browser notification
 * through the push-notifications plugin — a title and a count line, no item text; the announced keys are marked so a repeat
 * never goes out, quiet hours and owner_push.enabled apply, and a missing plugin or a failed send is quiet (the next tick asks again). */
export function mountOwnerBell(ctx: ServerCore, sweeps: readonly OwnerItemSweep[] = [], learningReader?: LearningItemsReader): void {
  scheduleIsolated(ctx.bb, "owner-bell", "*/5 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const notice = planBellNotice(ctx.db, Date.now(), sweeps, learningReader);
    if (!notice.send) return;
    const callRpc = (ctx.bb.sdk as { plugins?: { callRpc?: (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown> }) => Promise<unknown> } }).plugins?.callRpc;
    if (!callRpc) return;
    try {
      await callRpc({ pluginId: "push-notifications", method: "notifications.send", input: { title: notice.title, text: notice.text }, outputSchema: z.unknown() });
      ackDigest(ctx.db, notice.keys);
    } catch { /* no push plugin or a failed send: stay quiet, the next tick tries again */ }
  }, { timeoutMs: 30_000 });
}
