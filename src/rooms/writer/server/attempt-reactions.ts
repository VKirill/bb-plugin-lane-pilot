import { getAttempt, getReasoningTrace } from "../../storage";
import { recordSkillSwitchMetric } from "../skill-switch";
import { createSkillMaterializer, recordedMaterializedSkills } from "./skill-materialize";
import { recordedWriterSkills } from "./skill-pick";
import type { ServerCore, Services } from "../../core/server";
import { onAttemptFinished, type AttemptFinished } from "./attempt-finished";
import type { createWriterSticky } from "./sticky";

/**
 * The writer's own reactions to an attempt's end: the skill-switch metric, the materialized-skill
 * cleanup, the finish scan, and the area record of an accepted task. They stay in this room — unlike
 * the room-named files next to them, the merger keeps them here.
 *
 * Registration order is the run order (attempt-finished.ts). Attempt scope, from createWriterFinish:
 *   1. writer:skill-switch-metric → 2. writer:skill-materialize — the metric accounts the attempt
 *      before its skills leave the worktree (the old finally's order).
 *   3. writer:finish-scan — observational; used to run just before the acceptance receipt, now fires
 *      after it on the same data (it never changed the finish path).
 * Task scope, from createWriterStart (mountWriterTaskFinished):
 *   4. writer:area-accepted — the area's writer record, after the task's receipts and run refresh.
 */
export function mountWriterAttemptFinished(ctx: ServerCore, services: Services): void {
  const { bb, db } = ctx;
  const skillMaterial = createSkillMaterializer(ctx, (message) => bb.log.info(message));

  // A reload closes this instance's database; recovery in the new instance owns the attempt from then on.
  onAttemptFinished(ctx, async (event) => {
    if (event.scope !== "attempt" || ctx.state.disposed) return;
    try {
      const events = await bb.sdk.threads.events.list({ threadId: event.writerThreadId, limit: "100" } as never).then((r: any) => r?.events ?? [], () => []);
      if (!ctx.state.disposed) {
        recordSkillSwitchMetric(db, {
          attemptId: event.attemptId,
          taskId: event.taskId,
          runId: event.runId,
          projectId: event.projectId,
          events,
          skills: recordedWriterSkills(getReasoningTrace(db, event.attemptId)?.dispatchContext),
          outcome: event.result?.status === "accepted" || (event.result as { state?: unknown } | null)?.state === "accepted" ? "accepted" : "failed",
        });
      }
    } catch (cause) {
      ctx.log(`writer skill switch metric failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (!ctx.state.disposed) await skillMaterial.remove({ attemptId: event.attemptId, hostId: event.config.hostId,
      workspacePath: getAttempt(db, event.attemptId)?.workspace_path ?? null,
      names: recordedMaterializedSkills(getReasoningTrace(db, event.attemptId)?.dispatchContext),
      providerId: getReasoningTrace(db, event.attemptId)?.providerId ?? null });
  }, "writer:skill-metric-and-materialize");
}

/** Task-scope reactions the writer owns; mounted by createWriterStart with its sticky instance. */
export function mountWriterTaskFinished(ctx: ServerCore, _services: Services, sticky: ReturnType<typeof createWriterSticky>): void {
  // The area's writer record: accepted work makes this thread the area's hot writer for the next task.
  onAttemptFinished(ctx, (event) => {
    if (event.scope !== "task" || event.status !== "accepted" || !event.acceptedAttemptId) return;
    return sticky.noteAccepted(event.projectId, event.runId, event.task, event.acceptedAttemptId,
      Array.isArray(event.result?.produced) ? (event.result.produced as unknown[]).filter((path): path is string => typeof path === "string") : [])
      .then(() => undefined, (cause: unknown) => { ctx.log(`area record of ${event.taskId} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return undefined; });
  }, "writer:area-accepted");
}
