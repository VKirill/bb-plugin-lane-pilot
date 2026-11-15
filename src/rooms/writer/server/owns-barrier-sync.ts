import type { TaskV2 } from "../../contracts";
import { configuredSetting, type ServerCore } from "../../contracts/server";
import { getRunSettingsScopes } from "../../storage";

/**
 * What an in-place contract change did to the attempt's owns barrier (EXT05, layers audit 2026-11-15). The barrier
 * makes tracked files outside owns_paths read-only in the lane worktree once, at bind; a contract widened in place
 * told the writer «edit X» while the OS still refused X. `ok: false` means the change must not go out: either the
 * host has no such operation (nothing ran), or the host's answer is unknown (`uncertain`: a late or partial change may
 * have happened; one attempt to put the old contract's barrier back was made).
 */
export type OwnsBarrierSync = { ok: true } | { ok: false; uncertain: boolean; hint: string };

const ownsChanged = (from: TaskV2, to: TaskV2) =>
  JSON.stringify(from.owns_paths) !== JSON.stringify(to.owns_paths) || JSON.stringify(from.never_touch ?? []) !== JSON.stringify(to.never_touch ?? []);

/** The SDK's own code for a host that does not know the method (experimental_PluginRpcCallError): an older host worker. */
const unknownMethod = (cause: unknown) => typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "unknown_method";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);

/**
 * Brings the barrier of `worktreePath` from `from` to `to` before the writer hears of the change. Nothing to do when
 * owns_paths and never_touch did not change, the attempt has no worktree, or writer.owns_barrier is off; a path that is
 * no lane worktree (a live folder) never had a barrier and the host leaves it alone.
 */
export async function syncOwnsBarrier(ctx: Pick<ServerCore, "db" | "host" | "effectiveProjectSettings" | "log">,
  input: { projectId: string; runId: string; hostId: string; worktreePath: string | null | undefined; from: TaskV2; to: TaskV2 }): Promise<OwnsBarrierSync> {
  if (!input.worktreePath || !ownsChanged(input.from, input.to)) return { ok: true };
  const settings = (await ctx.effectiveProjectSettings(input.projectId, getRunSettingsScopes(ctx.db, input.runId))).values;
  if (configuredSetting(settings, "writer.owns_barrier") === "off") return { ok: true };
  const worktreePath = input.worktreePath;
  // Only the two answers the method has count as done; anything else (a host that answered nothing) is not proof.
  const apply = async (task: TaskV2) => {
    const answer = await ctx.host.call("gitOwnsBarrier", { requestedHostId: input.hostId, worktreePath,
      ownsPaths: task.owns_paths, neverTouch: task.never_touch ?? [] }, { hostId: input.hostId, timeoutMs: 60_000 }) as { status?: unknown } | null | undefined;
    if (answer?.status !== "applied" && answer?.status !== "not_lane_worktree") throw new Error(`gitOwnsBarrier answered ${JSON.stringify(answer ?? null).slice(0, 120)}`);
  };
  try {
    await apply(input.to);
    return { ok: true };
  } catch (cause) {
    if (unknownMethod(cause)) {
      ctx.log(`owns barrier on ${input.hostId}: the host worker has no gitOwnsBarrier; the contract change is refused`);
      return { ok: false, uncertain: false, hint: `the Lane Pilot host worker on ${input.hostId} cannot update the owns barrier, so the writer could not edit the newly owned files; the contract was not changed — update the host worker (redeploy) or redispatch the task` };
    }
    const back = await apply(input.from).then(() => true, (again: unknown) => { ctx.log(`owns barrier rollback on ${input.hostId} failed: ${message(again)}`); return false; });
    ctx.log(`owns barrier on ${input.hostId} failed: ${message(cause)}; rollback to the old contract ${back ? "answered" : "failed"}`);
    return { ok: false, uncertain: true, hint: `the owns barrier could not be updated (${message(cause)}); the contract was not changed, but file permissions in the worktree may differ from it${back ? " (the old contract's barrier was applied again)" : ""} — redispatch the task if the writer is refused a file it owns` };
  }
}
