import { createPhaseDriver as createDriver } from "../src/rooms/phase/server/driver";
import { createPhaseReactions } from "../src/rooms/wiring";
import type { ServerCore } from "../src/rooms/contracts/server";
import type { Services } from "../src/rooms/core/server/services";

/** The phase driver wired the way server.ts wires it: the composition root's reactions, not a default inside the room. */
export function createPhaseDriver(ctx: ServerCore, services: Services) {
  return createDriver(ctx, services, createPhaseReactions(ctx.db, ctx.bb));
}
