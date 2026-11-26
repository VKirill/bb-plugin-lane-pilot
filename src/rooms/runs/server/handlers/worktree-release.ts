import { cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees, ENVIRONMENT_GRACE_MS } from "../services/run-finish";
import { STICKY_WINDOW_MS, type WorkflowEngineApi } from "../../../platform/server";
import { attemptUpdatedAt, getAttempt, getTask } from "../../../storage";
import type { ServerCore } from "../../../contracts/server";

/**
 * Registers the `lp.worktree_release_plan` and `lp.attempt_release_worktree` workflow actions used by
 * `workflows/lp.worktree-release.json` (triggered on `lp.attempt.finished`), replacing the 10-minute
 * `attempt-worktree-sweep` cron with durable per-attempt grace-window waits.
 */
export function registerWorktreeReleaseActions(engine: WorkflowEngineApi["workflowEngine"], ctx: Pick<ServerCore, "bb" | "db" | "host" | "log">): void {
  const released = new Set<string>();
  const snapshotWorktree = async (hostId: string, worktreePath: string, name: string) =>
    await ctx.host.call("gitWorktreeSnapshot", { requestedHostId: hostId, worktreePath, name }, { hostId, timeoutMs: 300_000 }) as { status: "clean" | "saved" | "missing" | "failed"; path: string | null; reason: string | null };
  const removeLaneWorktree = async (hostId: string, basePath: string, worktreePath: string) =>
    Boolean((await ctx.host.call("gitRemoveWorktree", { requestedHostId: hostId, basePath, worktreePath, release: true }, { hostId, timeoutMs: 300_000 }) as { removed?: boolean } | null)?.removed);

  engine.register("lp.worktree_release_plan", {
    reentrant: true,
    run: async (stepCtx) => {
      const attemptId = typeof stepCtx.input.with?.attemptId === "string" ? stepCtx.input.with.attemptId : "";
      if (!attemptId) return { output: { shouldRelease: false, waitUntil: engine.now(), released: 0 } };
      const attempt = getAttempt(ctx.db, attemptId);
      if (!attempt || (!attempt.environment_id && !attempt.workspace_path && !attempt.holder_thread_id)) {
        return { output: { shouldRelease: false, waitUntil: engine.now(), released: 0 } };
      }
      const contract = getTask(ctx.db, attempt.task_id)?.contract as { area?: unknown } | undefined;
      const hasArea = typeof contract?.area === "string" && contract.area.trim().length > 0;
      const graceMs = hasArea ? STICKY_WINDOW_MS : ENVIRONMENT_GRACE_MS;
      return { output: { shouldRelease: true, waitUntil: (attemptUpdatedAt(ctx.db, attemptId) ?? engine.now()) + graceMs, released: 0 } };
    },
  });

  engine.register("lp.attempt_release_worktree", {
    reentrant: true,
    run: async () => {
      const now = engine.now();
      const [envs, lanes] = await Promise.all([
        cleanupFinishedAttemptEnvironments(ctx.bb, ctx.db, snapshotWorktree, now).catch((cause) => {
          ctx.log(`Lane Pilot worktree release (env) skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
          return [] as string[];
        }),
        cleanupStickyLaneWorktrees(ctx.db, removeLaneWorktree, released, now).catch((cause) => {
          ctx.log(`Lane Pilot worktree release (lane) skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
          return [] as string[];
        }),
      ]);
      if (envs.length || lanes.length) {
        ctx.log(`Lane Pilot worktree release: freed ${envs.length} environment(s), ${lanes.length} lane worktree(s)`);
      }
      return { output: { released: envs.length + lanes.length } };
    },
  });
}
