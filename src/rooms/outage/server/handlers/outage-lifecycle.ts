import type { ServerCore } from "../../../contracts/server";
import { markReloadStop, recordStartGap } from "../services/outage-service";

/** The start's gap check and the stop marker; the beat itself is stamped by the engine clock (`stampBeat`), which has its own timer anyway. */
export async function mountOutage(ctx: ServerCore): Promise<void> {
  await recordStartGap(ctx);
  // The last words of this run: a reload or a deploy names itself, so the next start does not count it as a death.
  ctx.bb.onDispose(() => { void markReloadStop(ctx); });
}
