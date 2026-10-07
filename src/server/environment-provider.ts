import { z } from "zod";
import type { ServerCore } from "./core";

/** The environment provider Lane Pilot registers for writer attempts (H9); BB's provider ids are global. */
export const LANE_WORKTREE_PROVIDER_ID = "lane-pilot-worktree";

/**
 * BB retires an environment this long after its last thread is archived. A worktree is about 2 GB (110 of them filled
 * the OVH disk on 2026-10-03), so this stays short, as for BB's own managed worktree. A worktree an area keeps for its
 * next task is not at risk: Lane Pilot leaves that writer's thread unarchived for the sticky window.
 */
export const LANE_WORKTREE_RETIRE_GRACE_MS = 5 * 60_000;

/**
 * `basePath` is the run folder the worktree forks (a project root, a section with its own repository, or a subfolder of
 * a larger repo: the host's gitCreateWorktree knows the layout), `name` the attempt id (branch `lane/<name>`), `path` the
 * worktree Lane Pilot already made before the thread starts, because the execution packet and the dirt baseline are read
 * from it first.
 */
export const laneWorktreeInputs = z.object({
  basePath: z.string().startsWith("/"),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
  path: z.string().startsWith("/").optional(),
}).strict();
export type LaneWorktreeInputs = z.infer<typeof laneWorktreeInputs>;

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/**
 * Registers `lane-pilot-worktree`, modelled on the official environment-git-worktree plugin: BB owns the environment row
 * and its lifecycle, the existing host functions (gitCreateWorktree, gitPrepareWorktree, gitRemoveWorktree) do the work.
 * Returns false, and registers nothing, on a BB without environment providers.
 */
export function registerLaneWorktreeProvider(ctx: ServerCore): boolean {
  const { bb, db, host } = ctx;
  const environments = (bb as { experimental_environments?: { register?: unknown } }).experimental_environments;
  if (typeof environments?.register !== "function") {
    bb.log.info("Lane Pilot: this BB has no environment providers; writer worktrees stay on the old path");
    return false;
  }

  /** The attempt's worktree already stands on its machine: a lane/<name> checkout. */
  async function isLaneWorktree(hostId: string, path: string, name: string, signal: AbortSignal): Promise<boolean> {
    const ran = await host.call("runCommand", { requestedHostId: hostId, command: "git rev-parse --abbrev-ref HEAD", cwd: path, timeoutSec: 15 },
      { hostId, timeoutMs: 20_000, signal }).catch(() => null);
    return Boolean(ran && ran.exitCode === 0 && ran.stdout.trim() === `lane/${name}`);
  }

  try {
    bb.experimental_environments.register({
      id: LANE_WORKTREE_PROVIDER_ID,
      displayName: "Lane Pilot worktree",
      description: "A git worktree of the run's folder for one Lane Pilot writer attempt.",
      icon: "FolderGit",
      inputs: laneWorktreeInputs,
      policy: { pathKeys: "per-attempt", retireGraceMs: LANE_WORKTREE_RETIRE_GRACE_MS },
      async create(context) {
        const inputs = context.inputs;
        const hostId = context.host.id;
        try {
          let path = inputs.path ?? null;
          // A made worktree is taken as it is; one that is gone (a retry of a removed environment) is made again at the same path.
          if (!path || !await isLaneWorktree(hostId, path, inputs.name, context.signal)) {
            context.report.step("Creating the worktree");
            const created = await host.call("gitCreateWorktree", { requestedHostId: hostId, basePath: inputs.basePath, name: inputs.name },
              { hostId, timeoutMs: 120_000, signal: context.signal });
            if (created.status !== "ready" || !created.path) return { status: "failed", message: `attempt_worktree_failed:${created.reason ?? "unknown"}` };
            path = created.path;
            context.report.step("Linking dependencies");
            // Linking dependencies helps the writer's checks; a host without it still gets a clean worktree.
            await host.call("gitPrepareWorktree", { requestedHostId: hostId, basePath: inputs.basePath, worktreePath: path },
              { hostId, timeoutMs: 600_000, signal: context.signal }).catch(() => undefined);
          }
          return { status: "created", path, ownsPath: true, resource: { basePath: inputs.basePath, name: inputs.name, path } };
        } catch (cause) {
          if (context.signal.aborted) throw cause;
          return { status: "failed", message: errorMessage(cause) };
        }
      },
      async remove(context) {
        if (context.hostId === null) return { status: "failed", message: "The worktree machine is unknown" };
        const hostId = context.hostId;
        // What was made: the create result's resource, else what the thread was asked for (a create that never answered).
        const known = laneWorktreeInputs.safeParse(context.resource ?? context.environment?.environmentProviderSelection?.inputs);
        const path = context.path ?? (known.success ? known.data.path ?? null : null);
        if (!path) return { status: "removed" };
        // A provider that failed to start its thread left an environment on the worktree that the attempt then used without
        // one (the fallback): removing the environment must not take that worktree with it.
        if (db.prepare("SELECT 1 FROM lane_pilot_attempt WHERE workspace_path=? AND environment_id IS NULL LIMIT 1").get(path)) return { status: "removed" };
        if (!known.success) return { status: "failed", message: "The worktree's base folder is unknown" };
        try {
          // What the writer left is saved before the worktree goes (the sweeps do the same), also when BB retires it on its own.
          const saved = await host.call("gitWorktreeSnapshot", { requestedHostId: hostId, worktreePath: path, name: known.data.name },
            { hostId, timeoutMs: 300_000, signal: context.signal });
          if (saved.status === "failed") return { status: "failed", message: `The worktree's changes could not be saved: ${saved.reason ?? "unknown"}` };
          if (saved.status === "missing") return { status: "removed" };
          const removed = await host.call("gitRemoveWorktree", { requestedHostId: hostId, basePath: known.data.basePath, worktreePath: path },
            { hostId, timeoutMs: 60_000, signal: context.signal });
          return removed.removed ? { status: "removed" } : { status: "failed", message: `${path} is not a Lane Pilot worktree, so it was left` };
        } catch (cause) {
          if (context.signal.aborted) throw cause;
          return { status: "failed", message: errorMessage(cause) };
        }
      },
    });
  } catch (cause) {
    bb.log.warn(`Lane Pilot: the environment provider ${LANE_WORKTREE_PROVIDER_ID} did not register: ${errorMessage(cause)}`);
    return false;
  }
  return true;
}
