import { z } from "zod";
import { sha256Hex } from "@lane-pilot/kit";
import type { ServerCore } from "../../contracts/server";
import type { stringAt as stringAtOf } from "@lane-pilot/kit";
import type { RepairWorktree, SelfRepairConfig, SelfRepairState, SignatureRecord } from "./types";

export const MERGE_TRIES = 4;
/** A repair thread that ended without a verdict for this long is abandoned: its worktree is saved as a patch and released. */
const ABANDON_MS = 86_400_000;
/** How long a pass waits for the graph run of a repair to start its thread (the worktree is made and prepared first); the run goes on after it. */
const SPAWN_WAIT_MS = 12 * 60_000;

async function placeThread(bb: ServerCore["bb"], log: (message: string) => void, threadId: string, projectId: string, folderId: string): Promise<void> {
  try {
    await bb.sdk.plugins.callRpc({ pluginId: "project-folders", method: "thread_place", input: { threadId, projectId, folderId },
      outputSchema: z.object({ ok: z.literal(true) }) });
  } catch (cause) {
    log(`self-repair: could not file @thread:${threadId} in section ${folderId}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function threadBusy(bb: ServerCore["bb"], stringAt: typeof stringAtOf, threadId: string): Promise<boolean> {
  const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
  const status = stringAt(thread, "status");
  return status !== null && status !== "idle" && status !== "error" && status !== "stopped";
}

/**
 * The repair thread's own worktree (E2). Repair threads used to work in the checkout the owner and other sessions
 * share and deployed from it, so a repair's half-done edits could ride along in someone else's deploy. Now each repair
 * gets a Lane Pilot worktree under ~/.lane-pilot/worktrees on a lane/self-repair-… branch from that checkout's HEAD;
 * its host and path are the configured environment's.
 */
async function createRepairWorktree(bb: ServerCore["bb"], host: ServerCore["host"], stringAt: typeof stringAtOf,
  cfg: SelfRepairConfig, signature: string, now: number): Promise<RepairWorktree> {
  const environment = await bb.sdk.environments.get({ environmentId: cfg.environmentId });
  const hostId = stringAt(environment, "hostId"), basePath = stringAt(environment, "path");
  if (!hostId || !basePath) throw new Error(`environment ${cfg.environmentId} has no host path`);
  const name = `self-repair-${sha256Hex(signature).slice(0, 8)}-${now.toString(36)}`;
  const created = await host.call("gitCreateWorktree", { requestedHostId: hostId, basePath, name }, { hostId, timeoutMs: 120_000 });
  if (created.status !== "ready" || !created.path || !created.branch) throw new Error(`worktree not created: ${created.reason ?? "unknown"}`);
  // node_modules and built output are linked in so the suite runs there at once; without them the repair reinstalls.
  await host.call("gitPrepareWorktree", { requestedHostId: hostId, basePath, worktreePath: created.path }, { hostId, timeoutMs: 600_000 }).catch(() => undefined);
  return { hostId, basePath, path: created.path, branch: created.branch };
}

/** The worktree goes away; whatever it still holds is first saved as a patch under ~/.lane-pilot/released. */
async function releaseWorktree(host: ServerCore["host"], worktree: RepairWorktree): Promise<void> {
  const name = worktree.branch.replace(/^lane\//, "");
  await host.call("gitWorktreeSnapshot", { requestedHostId: worktree.hostId, worktreePath: worktree.path, name }, { hostId: worktree.hostId, timeoutMs: 120_000 }).catch(() => null);
  await host.call("gitRemoveWorktree", { requestedHostId: worktree.hostId, basePath: worktree.basePath, worktreePath: worktree.path }, { hostId: worktree.hostId, timeoutMs: 120_000 }).catch(() => null);
}

/**
 * A repair thread that stopped: verdict fixed — its branch is merged into the shared checkout the way a writer's work
 * is (under the base lock, rebased on the current HEAD, the worktree removed). A conflict or failure is retried on
 * later passes, then the branch is left for the owner. Any other verdict — nothing of it is merged, the worktree is
 * saved as a patch and released. Nothing here deploys: the release train does.
 */
async function settleWorktree(host: ServerCore["host"], log: (message: string) => void, release: (worktree: RepairWorktree) => Promise<void>,
  record: SignatureRecord, signature: string, now: number): Promise<void> {
  const worktree = record.worktree!;
  if (record.verdict === "fixed") {
    const title = signature.split(":").slice(2).join(":").slice(0, 100);
    const result = await host.call("gitIntegrate", { requestedHostId: worktree.hostId, basePath: worktree.basePath, worktreePath: worktree.path,
      message: `self-repair: ${title}`, removeWorktree: true }, { hostId: worktree.hostId, timeoutMs: 300_000 })
      .catch((cause) => ({ status: "failed" as const, commit: null, reason: cause instanceof Error ? cause.message : String(cause) }));
    if (result.status === "merged" || result.status === "up-to-date") {
      record.worktree = null;
      record.outcome = result.status === "merged" ? `merged ${String(result.commit ?? "").slice(0, 12)}` : "up-to-date";
      record.mergedCommit = result.status === "merged" && result.commit ? String(result.commit) : null;
      log(`self-repair: ${record.outcome} from ${worktree.branch}; it ships with the next release`);
      return;
    }
    if (result.status !== "busy") worktree.mergeTries = (worktree.mergeTries ?? 0) + 1;
    record.outcome = `${result.status}: ${String(result.reason ?? "").slice(0, 200)}`;
    if ((worktree.mergeTries ?? 0) >= MERGE_TRIES) log(`self-repair: ${worktree.branch} failed to merge ${MERGE_TRIES} times; the next pass releases it: ${record.outcome}`);
    return;
  }
  if (!record.verdict && now - (record.spawnedAt ?? now) < ABANDON_MS) return;
  // The owner's «go ahead» continues the repair thread in this worktree: it stays until he answers or the question times out.
  if (record.verdict === "needs-owner" && (record.ownerWaitUntil ?? 0) > now) return;
  await release(worktree);
  record.worktree = null;
  record.outcome = `released: ${record.verdict ?? "no verdict"}`;
}

/**
 * Waits until the graph run of a repair has started its thread (the record names it, with this pass's time), has ended without one, or a limit
 * passes: the worktree is made, linked and prepared first, which takes minutes on a large checkout.
 */
async function waitForSpawn(db: ServerCore["db"], getState: () => Promise<SelfRepairState>, isDisposed: () => boolean,
  signature: string, runId: string, at: number, signal?: AbortSignal): Promise<"spawned" | "failed" | "pending"> {
  const deadline = Date.now() + SPAWN_WAIT_MS;
  for (;;) {
    signal?.throwIfAborted();
    const record = (await getState()).signatures[signature];
    if (record?.threadId && record.spawnedAt === at) return "spawned";
    const row = db.prepare("SELECT status FROM lane_pilot_wf_run WHERE id=?").get(runId) as { status: string } | undefined;
    if (row && row.status !== "running" && row.status !== "waiting") return row.status === "succeeded" ? "pending" : "failed";
    if (Date.now() >= deadline || isDisposed()) return "pending";
    await new Promise((done) => setTimeout(done, 200));
  }
}

export { placeThread, threadBusy, createRepairWorktree, releaseWorktree, settleWorktree, waitForSpawn };
