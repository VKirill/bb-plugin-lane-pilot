import { bestEffort } from "@lane-pilot/kit";
import type { ServerCore } from "../../contracts/server";
import { getRepairHooks } from "./hooks";
import { MERGE_TRIES, releaseWorktree, settleWorktree } from "./spawn";
import type { SignatureRecord } from "./types";

export function createSettleRecord(ctx: ServerCore) {
  const { host } = ctx;

  /** One pass over a finished repair's worktree: a failed-merges limit releases it, a night repair asks the night policy, a fixed branch is merged. */
  async function settleRecord(signature: string, record: SignatureRecord, now: number): Promise<void> {
    const night = signature.startsWith("night:") ? getRepairHooks(ctx) : undefined;
    // Merges that failed MERGE_TRIES times are not left on their branch «for the owner» (he takes no part in the loop): the work is
    // saved as a patch, the worktree goes, and a night repair's round counts as failed so its class is taken again on a fresh main.
    if ((record.worktree!.mergeTries ?? 0) >= MERGE_TRIES) {
      const last = record.outcome ?? "";
      await releaseWorktree(host, record.worktree!, ctx.log);
      record.worktree = null;
      record.outcome = `released after ${MERGE_TRIES} failed merges: ${last}`.slice(0, 400);
      ctx.log(`self-repair: ${signature} ${record.outcome}`);
      night?.settled(signature, { outcome: record.outcome, verdict: record.verdict ?? null, commit: null });
      return;
    }
    if (night && record.verdict === "fixed") {
      // A night repair is merged only when the night policy lets the night do it alone; otherwise it waits on its branch (held) or is released.
      const decision = await bestEffort(ctx.log, "night merge gate", night.mergeGate(signature, { threadId: record.threadId!, worktree: record.worktree! }), "hold" as const);
      if (decision === "hold") return;
      if (decision === "release") {
        await releaseWorktree(host, record.worktree!, ctx.log);
        record.worktree = null;
        record.outcome = "released: held by the night policy";
        night.settled(signature, { outcome: record.outcome, verdict: record.verdict ?? null, commit: null });
        return;
      }
    }
    await settleWorktree(host, ctx.log, (worktree) => releaseWorktree(host, worktree, ctx.log), record, signature, now);
    if (night && !record.worktree) {
      // The full SHA kept beside the outcome; the text is only the fallback for a merge recorded before it existed (the wall resolves a short one before it reverts).
      const merged = /^merged (\S+)/.exec(record.outcome ?? "")?.[1] ?? null;
      night.settled(signature, { outcome: record.outcome ?? "", verdict: record.verdict ?? null, commit: merged ? record.mergedCommit ?? merged : null });
      record.mergedCommit = null;
    }
  }

  return settleRecord;
}
