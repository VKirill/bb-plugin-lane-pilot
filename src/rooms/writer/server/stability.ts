
import type { ServerCore } from "../../contracts/server";
import { bestEffort } from "@lane-pilot/kit";
import type { FailureClass } from "../../contracts/failure-class";
import { onAttemptFinished } from "./attempt-finished";

import type { StabilityApi } from "../../stability/server/stability";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  stability: StabilityApi;
}

/**
 * MERGER: this file belongs to src/rooms/stability. Move it there and call
 * `mountStabilityAttemptFinished(ctx, services)` from that room's mount code instead of writer's.
 *
 * Stability hears once that a task's writer session ended failed: drills and the parked-task record
 * read it. Accepted and canceled tasks report nothing. This used to fire before the stage receipts
 * were written; as a reaction it fires right after them — the receipts carry the same outcome it reads.
 */
export function mountStabilityAttemptFinished(ctx: ServerCore, services: Services): void {
  onAttemptFinished(ctx, (event) => {
    if (event.scope !== "task" || event.status === "accepted" || event.status === "canceled") return;
    void bestEffort(ctx.log, "writer stability failure record", services.stability.onTaskFailed({ projectId: event.projectId, runId: event.runId, taskId: event.taskId,
      pmThreadId: event.pmThreadId, state: event.status, reason: event.reason ?? "",
      ...(event.judged ? { klass: event.judged.failureClass as FailureClass, mast: event.judged.mast, intervention: event.judged.intervention } : {}) }), false);
  }, "stability:task-failed");
}
