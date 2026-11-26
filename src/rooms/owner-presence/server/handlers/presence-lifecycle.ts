import type { ServerCore } from "../../../contracts/server";
import type { OwnerPresenceApi } from "../services/presence-service";

/** Loads stored owner-presence marks into memory at plugin startup. */
export function mountOwnerPresence(ctx: ServerCore, api: OwnerPresenceApi): void {
  void api.sweep().catch((cause: unknown) => ctx.log(`owner presence load failed: ${cause instanceof Error ? cause.message : String(cause)}`));
}
