import { createSelfRepair as createRepair } from "../../src/rooms/self-repair/server/self-repair";
import { selfRepairDeps } from "../../src/rooms/self-repair/server";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { WorkflowEngine } from "../../src/rooms/workflow";

/** createSelfRepair with the composition root's deps bag, so tests need no core imports of their own. */
export function createSelfRepair(ctx: ServerCore, engineOf?: () => WorkflowEngine | undefined) {
  return createRepair(ctx, selfRepairDeps(), engineOf);
}
