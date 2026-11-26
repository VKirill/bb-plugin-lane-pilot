import { onAttemptChanged } from "../../../storage";
import type { ServerCore } from "../../../contracts/server";
import { onOutboundAttemptChanged } from "../services/outbound";

export function mountOutbound(ctx: Pick<ServerCore, "db" | "bb" | "log" | "isDisposed">): void {
  const sent = new Set<string>();
  const stop = onAttemptChanged(ctx.db, (attemptId) => {
    onOutboundAttemptChanged(ctx, sent, attemptId);
  });
  ctx.bb.onDispose(stop);
}
