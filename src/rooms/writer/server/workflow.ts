import type { Services } from "../../platform/server";
import type { ServerCore } from "../../contracts/server";
import { onAttemptFinished } from "./attempt-finished";

/**
 * MERGER: this file belongs to src/rooms/workflow. Move it there and call
 * `mountWorkflowAttemptFinished(ctx, services)` from that room's mount code instead of writer's.
 *
 * The after-acceptance graph starts once a task landed (start.ts's epilogue, after the receipts and
 * the run refresh — the order kept here by emitting the task event at the end of the epilogue).
 */
export function mountWorkflowAttemptFinished(ctx: ServerCore, services: Services): void {
  onAttemptFinished(ctx, (event) => {
    if (event.scope !== "task" || event.status !== "accepted") return;
    services.startAfterAcceptance(event.projectId, event.runId, event.taskId, event.pmThreadId);
  }, "workflow:after-accept");
}
