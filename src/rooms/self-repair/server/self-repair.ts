import { stringAt } from "@lane-pilot/kit";
import { writerReuseStats } from "../writer-reuse-stats";
import { writerBriefStats } from "../writer-brief-stats";
import type { ServerCore } from "../../contracts/server";
import type { RepairDeps } from "./deps";
import type { WorkflowEngine } from "../../workflow";
import { DRILL_SANDBOX_PROJECT_IDS } from "../../contracts"
import { criticStats } from "../../critique";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import { getRepairHooks, type NightAssignment } from "./hooks";
import { LOADED_AT, VERSION, isDue, pointsAtEngine, repairPriority } from "./episodes";
import { readVerdict, type VerdictEnv } from "./verdict";
import { createRepairWorktree, placeThread, releaseWorktree, threadBusy, waitForSpawn } from "./spawn";
import { selfRepairStatus } from "./report";
import type { Incident, RepairWorktree, SelfRepairConfig, SignatureRecord } from "./types";
import {SELF_REPAIR} from "../../contracts";
import { createCollector } from "./collect";
import { createGraphRegistrar } from "./graph";
import { createRegrouper } from "./regroup";
import { createRepairSpawner, PENDING_MS } from "./spawn-repair";
import { createRepairState, SAMPLE_REASON_CHARS, STATE_BUDGET_BYTES } from "./repair-state";
import { createSettleRecord } from "./settle-record";

/**
 * Self-repair: every 15 minutes Lane Pilot looks for failures that are its own fault (triage origin
 * «orchestrator», system-looking block reasons, attempts stuck while their writer idles). Each new kind of
 * problem gets one repair thread — the configured high-reasoning model — in the Lane Pilot repository,
 * which finds the cause, fixes, verifies live, ships and tells the affected PM. The owner is not involved.
 */

const FORGET_MS = 30 * 86_400_000;
/** Time the repair thread gets to start the turn the owner's «go ahead» queued before its closing line is read again. */
const CONTINUE_GRACE_MS = 5 * 60_000;

export function createSelfRepair(ctx: ServerCore, deps: RepairDeps, engineOf?: () => WorkflowEngine | undefined) {
  const { bb, db, host } = ctx;
  const { clearSpawnMarker, keyedSpawnSupported } = deps;
  const { config, setConfig, state, fitState, writeState, patchRecord, runIsLive } = createRepairState(ctx);
  const collect = createCollector({ bb, db });
  const regroup = createRegrouper(ctx);

  const verdictEnv: VerdictEnv = {
    bb,
    log: ctx.log,
    patchRecord,
    get ownerAsk() { return ctx.ownerAsk; },
  };

  const settleRecord = createSettleRecord(ctx);
  const spawnRepairThread = createRepairSpawner({ bb, db, ctx, deps });
  const registerGraph = createGraphRegistrar(ctx, deps, { config, state, writeState, patchRecord, verdictEnv, spawnRepairThread, settleRecord });

  /**
   * One pass: collect since the cursor, remember each kind of problem with a few samples, start at most one repair
   * thread for the oldest kind nobody has taken yet. Kinds that wait (a repair running, the daily limit) stay in the
   * state and are taken on a later pass; a kind seen again a day after its repair started gets a new repair.
   */
  async function tick(options: { dryRun?: boolean; since?: number; signal?: AbortSignal } = {}): Promise<{ incidents: number; signatures: string[]; spawned: string | null; reason: string }> {
    const { signal } = options;
    const cfg = await config();
    const current = await state();
    const now = Date.now();
    signal?.throwIfAborted();
    const incidents = await collect(options.since ?? current.cursor, cfg);
    signal?.throwIfAborted();
    if (!options.dryRun) await regroup(incidents, current, cfg);
    signal?.throwIfAborted();
    const groups = new Map<string, Incident[]>();
    for (const row of incidents) groups.set(row.signature, [...(groups.get(row.signature) ?? []), row]);
    for (const [signature, rows] of groups) {
      const record = current.signatures[signature] ?? { firstAt: now, lastAt: now, count: 0, threadId: null, spawnedAt: null, samples: [] };
      const fresh = rows.filter((row) => !record.samples.some((seen) => seen.attemptId === row.attemptId))
        .map((row) => ({ ...row, reason: row.reason.slice(0, SAMPLE_REASON_CHARS), version: row.at >= LOADED_AT ? VERSION : null }));
      if (fresh.length) record.lastAt = now;
      record.count += fresh.length;
      record.samples = [...record.samples, ...fresh].slice(-6);
      current.signatures[signature] = record;
    }
    for (const [signature, record] of Object.entries(current.signatures)) if (now - record.lastAt > FORGET_MS) {
      if (record.pending && !options.dryRun) await releaseWorktree(host, record.pending.worktree, ctx.log);
      delete current.signatures[signature];
    }
    for (const [signature, record] of Object.entries(current.signatures)) {
      signal?.throwIfAborted();
      // A repair whose graph run is going reads its own verdict (the `verdict` step of the run).
      if (!record.threadId || record.verdict || runIsLive(record.runId) || await threadBusy(bb, stringAt, record.threadId)) continue;
      if (record.continuedAt && now - record.continuedAt < CONTINUE_GRACE_MS) continue;
      await readVerdict(verdictEnv, signature, record, options.dryRun === true, current);
    }
    if (!options.dryRun) {
      for (const [signature, record] of Object.entries(current.signatures)) {
        signal?.throwIfAborted();
        if (!record.worktree || !record.threadId || runIsLive(record.runId) || await threadBusy(bb, stringAt, record.threadId)) continue;
        await settleRecord(signature, record, now);
      }
    }
    const ignored = new Set([...cfg.ignoreProjects, ...DRILL_SANDBOX_PROJECT_IDS]);
    const due = Object.entries(current.signatures)
      // A night repair is started by the night loop's assignment, never by the watcher's own due rule.
      .filter(([signature, record]) => !signature.startsWith("night:") && isDue(record, now))
      .sort(([signatureA, a], [signatureB, b]) => repairPriority(signatureB, b, now, ignored) - repairPriority(signatureA, a, now, ignored) || a.firstAt - b.firstAt);
    let spawned: string | null = null;
    let reason = due.length ? "" : "nothing new";
    const today = current.spawned.filter((row) => now - row.at < 86_400_000);
    const active = await Promise.all(today.map((row) => threadBusy(bb, stringAt, row.threadId)));
    // The night loop's queued repair goes first and is not counted against the daily limit (the loop has its own: classes and tokens a night).
    const hooks = getRepairHooks(ctx);
    let night: NightAssignment | null = null;
    let target: [string, SignatureRecord] | null = null;
    if (hooks && cfg.enabled && !options.dryRun && !active.some(Boolean)) {
      night = hooks.nextAssignment();
      const existing = night ? current.signatures[night.signature] : undefined;
      // The round before on the same class must be settled (merged or released) first: one worktree per class.
      if (night && existing?.worktree) night = null;
      if (night) {
        const record: SignatureRecord = current.signatures[night.signature] ?? { firstAt: now, lastAt: now, count: 0, threadId: null, spawnedAt: null, samples: [] };
        record.samples = night.samples.map((row) => ({ ...row, reason: row.reason.slice(0, SAMPLE_REASON_CHARS) }));
        record.lastAt = now;
        record.count += 1;
        current.signatures[night.signature] = record;
        target = [night.signature, record];
      }
    }
    if (target) reason = "";
    else if (due.length && !cfg.enabled) reason = "self-repair is off";
    else if (due.length && active.some(Boolean)) reason = "a repair thread is still working";
    else if (due.length && today.length >= cfg.maxPerDay) reason = `daily limit ${cfg.maxPerDay} reached`;
    else if (due.length && options.dryRun) reason = `would start a repair for ${due[0]![0]}`;
    else if (due.length) target = due[0]!;
    if (target && !cfg.projectId) { reason = "no Lane Pilot project configured or discovered"; target = null; }
    // A repair is a run of the graph `lp.self-repair` (worktree, repair thread, verdict). Exception: a kind of failure whose class is the workflow
    // engine itself (packages/workflow-engine, src/rooms/workflow/) keeps the direct spawn below, because a broken engine cannot run its own repair.
    const graphEngine = engineOf?.();
    if (target && graphEngine && !pointsAtEngine(target[0], target[1].samples, night?.brief)) {
      const [signature, record] = target;
      if (runIsLive(record.runId)) reason = "a repair run is starting";
      else {
        // One id per repair of a kind (a spawn repeated after a lost answer is the same thread); one run key per try (a failed try is followed by a new run).
        const spawnId = `${signature}:${record.spawnedAt ?? 0}`;
        record.runTries = (record.runTries ?? 0) + 1;
        try {
          signal?.throwIfAborted();
          const workflow = graphEngine.resolveWorkflow(SELF_REPAIR);
          if (!workflow) throw new Error(`built-in workflow ${SELF_REPAIR} is not loaded`);
          // The steps read the kind's record from the stored state: it is written first.
          await writeState(current);
          const started = graphEngine.start({ workflow, key: `self-repair:${spawnId}:${record.runTries}`, link: { projectId: cfg.projectId },
            inputs: { signature, spawn_id: spawnId, at: now, night_id: night?.id ?? "", brief: night?.brief ?? "", selection: night?.selection ?? null } });
          started.done.catch((cause: unknown) => ctx.log(`self-repair: run ${started.runId} stopped: ${cause instanceof Error ? cause.message : String(cause)}`));
          const outcome = await waitForSpawn(db, state, ctx.isDisposed, signature, started.runId, now, signal);
          const fresh = await state();
          current.signatures[signature] = fresh.signatures[signature] ?? record;
          const mine = fresh.signatures[signature];
          if (mine?.threadId && mine.spawnedAt === now) { spawned = mine.threadId; reason = "started"; }
          else reason = outcome === "failed" ? `spawn failed: ${graphEngine.get(started.runId)?.error ?? "the repair run failed"}` : "the repair run is starting";
          current.spawned = [...today, ...fresh.spawned.filter((row) => now - row.at < 86_400_000 && !today.some((seen) => seen.threadId === row.threadId))];
        } catch (cause) {
          reason = `spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`;
          ctx.log(`self-repair: ${reason}`);
          if (night && !record.pending) hooks?.startFailed(night.id, reason);
        }
      }
    } else if (target) {
      const [signature, record] = target;
      let worktree: RepairWorktree | null = null;
      let spawnCalled = false;
      // One id per repair of a kind: a spawn repeated after a lost answer is the same repair thread, not a second one.
      const spawnId = `${signature}:${record.spawnedAt ?? 0}`;
      try {
        // An aborted tick starts nothing: a repair thread begun after the abort has nobody watching it.
        signal?.throwIfAborted();
        // No worktree, no repair: the shared checkout is not a fallback (that is the fault E2 removes); the kind stays due.
        worktree = record.pending?.worktree ?? await createRepairWorktree(bb, host, stringAt, cfg, signature, now);
        spawnCalled = true;
        spawned = await spawnRepairThread({ signature, samples: record.samples, worktree, cfg, spawnId, now, night });
        record.pending = null;
        if (!spawned) await releaseWorktree(host, worktree, ctx.log);
        if (spawned) {
          record.threadId = spawned;
          record.spawnedAt = now;
          record.spawnVersion = VERSION;
          record.verdict = null;
          record.worktree = worktree;
          record.outcome = null;
          current.spawned = [...today, { at: now, threadId: spawned, signature }];
          ctx.log(`self-repair: started @thread:${spawned} for ${signature}`);
          if (cfg.sectionId) await placeThread(bb, ctx.log, spawned, cfg.projectId, cfg.sectionId);
          if (night) hooks?.started(night.id, { threadId: spawned, branch: worktree.branch, at: now });
          reason = "started";
        }
      } catch (cause) {
        if (worktree && !spawned) {
          // The spawn threw: the thread may exist although its answer was lost, and a live repair thread must not lose its
          // worktree. With thread keys the next pass repeats the spawn and gets that thread back; without them, or after
          // PENDING_MS, the spawn is taken as not made.
          if (spawnCalled && keyedSpawnSupported(bb) && now - (record.pending?.at ?? now) < PENDING_MS) {
            record.pending = { worktree, at: record.pending?.at ?? now };
          } else {
            await releaseWorktree(host, worktree, ctx.log);
            record.pending = null;
            if (spawnCalled) await clearSpawnMarker(bb, { role: "self-repair", spawnId });
          }
        }
        reason = `spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`;
        ctx.log(`self-repair: ${reason}`);
        // A night assignment whose spawn is not being retried is over for this round (its worktree was released above).
        if (night && !record.pending) hooks?.startFailed(night.id, reason);
      }
    }
    if (!options.dryRun) {
      current.cursor = now;
      current.lastTickAt = now;
      const dropped = fitState(current);
      if (dropped) ctx.log(`self-repair: forgot ${dropped} old kind(s) to keep its state under ${STATE_BUDGET_BYTES / 1024} KB`);
      await writeState(current);
    }
    return { incidents: incidents.length, signatures: [...groups.keys()], spawned, reason };
  }

  async function status() {
    return selfRepairStatus({ db, config, state, collect });
  }

  return { config, setConfig, state, collect, tick, status, registerGraph };
}

export function selfRepairRpc(ctx: ServerCore, services: { workflowEngine: WorkflowEngine } | undefined, deps: RepairDeps) {
  const repair = createSelfRepair(ctx, deps, () => services?.workflowEngine);
  return {
    critic_stats: async ({ projectId, days }) => ({ days, stats:criticStats(ctx.db, projectId, Date.now() - days * 86400_000) }),
    writer_reuse_stats: async ({ projectId, days }) => ({ days, stats:writerReuseStats(ctx.db, projectId, Date.now() - days * 86400_000) }),
    deploy_drain: async ({ on }) => ({ version:VERSION, ...ctx.deployDrain.set(on) }),
    deploy_status: async () => ({ version:VERSION, ...ctx.deployDrain.status() }),
    self_repair_status: async () => repair.status(),
    self_repair_configure: async (patch) => repair.setConfig(patch),
    self_repair_tick: async ({ dryRun, since }) => repair.tick({ dryRun, since }),
    writer_brief_stats: async ({ projectId, since, until }) => writerBriefStats(ctx.db, projectId, since, until ?? Date.now()),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "critic_stats" | "writer_reuse_stats" | "deploy_drain" | "deploy_status" | "self_repair_status" | "self_repair_configure" | "self_repair_tick" | "writer_brief_stats">;
}

export type SelfRepair = ReturnType<typeof createSelfRepair>;

export function mountSelfRepair(ctx: ServerCore, services: { workflowEngine: WorkflowEngine } | undefined, deps: RepairDeps): SelfRepair {
  const repair = createSelfRepair(ctx, deps, () => services?.workflowEngine);
  // The steps of the graph `lp.self-repair` (worktree, repair thread, verdict) run on the workflow engine.
  if (services?.workflowEngine) repair.registerGraph(services.workflowEngine);
  // Isolated where the core allows: a long schedule of its own or of another plugin must not hold the watcher back.
  deps.scheduleIsolated(ctx.bb, "self-repair", "*/15 * * * *", async (signal) => {
    if (ctx.isDisposed()) return;
    const result = await repair.tick({ signal }).catch((cause) => {
      if (!ctx.isDisposed()) ctx.log(`self-repair tick failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { incidents: 0, signatures: [], spawned: null, reason: String(cause) };
    });
    if (result.incidents) ctx.log(`self-repair tick: ${result.incidents} incident(s), ${result.signatures.length} kind(s): ${result.reason}`);
  }, { timeoutMs: 20 * 60_000 });
  return repair;
}

export { VERDICTS, type Verdict, type Incident, type RepairWorktree, type SignatureRecord, type SelfRepairState, type PmLastOwnerAt } from "./types";
export type { SelfRepairConfig };
export { SELF_REPAIR_DEFAULTS } from "./repair-state";
export { readTail } from "./read-tail";
export { repairPrompt } from "./repair-prompt";
export { VERSION, LOADED_AT, reasonSignature, repairPriority, logIncidents, writerStrayFiles, writerRedCheck, pointsAtEngine, isDue, lastPmOwnerMessageAt } from "./episodes";
export { parseVerdict, repairStatus, repairAnswerForThread, readVerdict, labelJevReceipts, askOwnerAboutRepair } from "./verdict";
export { createRepairWorktree, releaseWorktree, placeThread, threadBusy, waitForSpawn, settleWorktree } from "./spawn";
export { readRepairRecord, selfRepairStatus, STATE_KEY } from "./report";
export { CONFIG_KEY, lanePilotProjectOrNotice, resolveLanePilotProject } from "./project";
