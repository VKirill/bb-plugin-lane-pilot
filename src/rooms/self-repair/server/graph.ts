import { stringAt } from "@lane-pilot/kit";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { withUsage } from "../../usage/server";
import type { StepContext, WorkflowEngine } from "../../workflow";
import type { ServerCore } from "../../contracts/server";
import type { RepairDeps } from "./deps";
import { VERSION } from "./episodes";
import { getRepairHooks, type NightAssignment } from "./hooks";
import { PENDING_MS, type SpawnRepairArgs } from "./spawn-repair";
import { createRepairWorktree, placeThread, releaseWorktree, threadBusy } from "./spawn";
import type { createRepairState } from "./repair-state";
import type { createSettleRecord } from "./settle-record";
import { readVerdict, type VerdictEnv } from "./verdict";
import type { SelfRepairState, SignatureRecord } from "./types";

export type RepairGraphFns = {
  config: () => ReturnType<ReturnType<typeof createRepairState>["config"]>;
  state: () => Promise<SelfRepairState>;
  writeState: (current: SelfRepairState) => Promise<void>;
  patchRecord: ReturnType<typeof createRepairState>["patchRecord"];
  verdictEnv: VerdictEnv;
  spawnRepairThread: (args: SpawnRepairArgs) => Promise<string | null>;
  settleRecord: ReturnType<typeof createSettleRecord>;
};

export function createGraphRegistrar(ctx: ServerCore, deps: RepairDeps, fns: RepairGraphFns) {
  const { bb, host } = ctx;
  const { clearSpawnMarker, keyedSpawnSupported } = deps;
  const { config, state, writeState, patchRecord, verdictEnv, spawnRepairThread, settleRecord } = fns;

  /**
   * The executors of the graph `lp.self-repair`, registered by the watcher's mount once the workflow engine exists. They work on the watcher's
   * stored state (the kind's record is the index; the journal keeps the steps) and are reentrant: a reload that cuts a step off runs it again
   * (the worktree and the thread are found again by the record, and the spawn key names the thread), and while the plugin stops a step holds
   * instead of failing, so the next instance picks the run up.
   */
  function registerGraph(engine: WorkflowEngine): void {
    const held = async <T>(work: () => Promise<T>): Promise<T> => {
      try { return await work(); } catch (cause) { if (ctx.isDisposed()) return await new Promise<T>(() => undefined); throw cause; }
    };
    const input = (c: StepContext, name: string): unknown => c.resolve(`$inputs.${name}`);
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    const stopOf = (c: StepContext) => (): string | null => (ctx.isDisposed() ? "plugin_stopped" : c.signal.aborted ? "aborted" : null);
    const recordOf = async (signature: string): Promise<SignatureRecord> => {
      const record = (await state()).signatures[signature];
      if (!record) throw new Error("the kind of failure this repair is for is no longer in the watcher's state");
      return record;
    };

    engine.register("lp.repair_worktree", { reentrant: true, run: (c) => held(async () => {
      const signature = text(input(c, "signature")), at = Number(input(c, "at"));
      const record = await recordOf(signature);
      // A worktree an earlier try of this repair kept is reused; no worktree, no repair (the shared checkout is not a fallback).
      const worktree = record.pending?.worktree ?? await createRepairWorktree(bb, host, stringAt, await config(), signature, at);
      await patchRecord(signature, (stored) => { stored.runId = c.runId; stored.pending = { worktree, at: stored.pending?.at ?? Date.now() }; });
      return { output: { path: worktree.path, branch: worktree.branch } };
    }) });

    engine.register("lp.repair", { reentrant: true, run: (c) => held(async () => {
      const signature = text(input(c, "signature")), spawnId = text(input(c, "spawn_id")), at = Number(input(c, "at")), nightId = text(input(c, "night_id"));
      const brief = text(input(c, "brief")), selection = input(c, "selection") as NightAssignment["selection"] | null;
      const cfg = await config();
      const record = await recordOf(signature);
      let threadId = record.runId === c.runId && record.spawnedAt === at ? record.threadId : null;
      if (!threadId) {
        const worktree = record.pending?.worktree;
        if (!worktree) throw new Error("the repair has no worktree to work in");
        let spawned: string | null = null;
        const failed = async (reason: string, kept: boolean) => {
          ctx.log(`self-repair: spawn failed: ${reason}`);
          // A night assignment whose spawn is not being retried is over for this round (its worktree was released).
          if (nightId && !kept) getRepairHooks(ctx)?.startFailed(nightId, `spawn failed: ${reason}`);
        };
        try {
          spawned = await spawnRepairThread({ signature, samples: record.samples, worktree, cfg, spawnId, now: at,
            night: nightId ? { brief, ...(selection ? { selection } : {}) } : null,
            step: { runId: c.runId, stepKey: c.stepKey, nodeId: c.nodeId } });
        } catch (cause) {
          // The spawn threw: the thread may exist although its answer was lost, and a live repair thread must not lose its worktree. With thread keys
          // the next try repeats the spawn and gets that thread back; without them, or after PENDING_MS, the spawn is taken as not made.
          const kept = keyedSpawnSupported(bb) && Date.now() - (record.pending?.at ?? Date.now()) < PENDING_MS;
          if (!kept) {
            await releaseWorktree(host, worktree, ctx.log);
            await patchRecord(signature, (stored) => { stored.pending = null; });
            await clearSpawnMarker(bb, { role: "self-repair", spawnId });
          }
          await failed(cause instanceof Error ? cause.message : String(cause), kept);
          throw cause;
        }
        if (!spawned) {
          await releaseWorktree(host, worktree, ctx.log);
          await patchRecord(signature, (stored) => { stored.pending = null; });
          await failed("threads.spawn returned no repair thread id", false);
          throw new Error("threads.spawn returned no repair thread id");
        }
        threadId = spawned;
        await patchRecord(signature, (stored, current) => {
          stored.pending = null; stored.threadId = threadId; stored.spawnedAt = at; stored.spawnVersion = VERSION; stored.verdict = null; stored.worktree = worktree; stored.outcome = null; stored.runId = c.runId;
          current.spawned = [...current.spawned.filter((row) => at - row.at < 86_400_000), { at, threadId: threadId!, signature }];
        });
        ctx.log(`self-repair: started @thread:${threadId} for ${signature}`);
        if (cfg.sectionId) await placeThread(bb, ctx.log, threadId, cfg.projectId, cfg.sectionId);
        if (nightId) getRepairHooks(ctx)?.started(nightId, { threadId, branch: worktree.branch, at });
      }
      // The thread's turn ends with its closing verdict line; a thread that failed has no verdict, which the verdict step records as none.
      let ended = "idle";
      try { await waitThreadIdle(bb, threadId, "self_repair", undefined, undefined, stopOf(c)); }
      catch (cause) {
        if (ctx.isDisposed() || c.signal.aborted) throw cause;
        ended = "error";
        ctx.log(`self-repair: @thread:${threadId} ended without finishing: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      return { output: { thread_id: threadId, ended, handoff: `repair thread ${threadId} ended (${ended})` }, ...(await withUsage(bb, threadId)) };
    }) });

    engine.register("lp.repair_verdict", { reentrant: true, run: (c) => held(async () => {
      const signature = text(input(c, "signature"));
      const record = await recordOf(signature);
      if (!record.threadId || record.runId !== c.runId) return { output: { verdict: "none", outcome: "the repair has no thread" } };
      const work: SignatureRecord = { ...record };
      if (!work.verdict) {
        // The verdict also labels the merge suggestions pointing at this signature: the labels ride the same state write.
        const current = await state();
        await readVerdict(verdictEnv, signature, work, false, current);
        await writeState(current);
      }
      // A branch that cannot be merged yet (a busy base, a conflict) stays: the watcher's next passes retry it, then release it.
      if (work.worktree && !(await threadBusy(bb, stringAt, record.threadId))) await settleRecord(signature, work, Date.now());
      await patchRecord(signature, (stored) => { stored.verdict = work.verdict; stored.ownerWaitUntil = work.ownerWaitUntil; stored.worktree = work.worktree; stored.outcome = work.outcome; stored.mergedCommit = work.mergedCommit; });
      return { output: { verdict: work.verdict ?? "none", outcome: work.outcome ?? "" } };
    }) });
  }

  return registerGraph;
}
