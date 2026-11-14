import { createHash } from "node:crypto";
import { switchOn } from "@lane-pilot/models";
import type { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { GLOBAL_SETTINGS_PROJECT_ID, SETTING_WORKER_STRICT_USER } from "@lane-pilot/settings-catalog";
import { attemptWorkspacePaths, recentAttemptWorkspaces, recentRunWorkspaces, finalTaskIdsSince, lastJanitorKept, listOpenWorktrees, loadProjectSettings, recordJanitorSweep, registerWorktree, releaseWorktree, releaseWorktreeById, releaseWorktreesUnder, writerBaseForWorkspace } from "../../storage";
import { STICKY_WINDOW_MS, listQaHosts } from "../../platform/server";
import type { ChainRuntime } from "../../contracts/server";
import { REPORTED_KEEP_REASONS } from "../../verification";
import { closeOwnerItem, closeOwnerItemsByPrefix, hasOpenOwnerItem, listOpenOwnerItemKeys, postOwnerItem, rpcLine } from "../../owner-waiting";
import { configuredSetting } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";
import { OPEN_ATTEMPT_STATES, RETRY_ELIGIBLE, isOpenAttemptState } from "../../contracts/state-machine";
import { DOCS_WORKTREE_PREFIX, docsWorktreeKey, REGRESS_MARKER_TTL_MS, REGRESS_WORKTREE_PREFIX, regressWorktreeKey, regressWorktreePath, SELF_REPAIR_STATE_KEY, selfRepairWorktrees } from "../../contracts";
import { bestEffort } from "@lane-pilot/kit";
import { listPhases } from "../../phase";
import { recordEvidence } from "../../storage";
import { disarmedProjects, rearmExpiredDisarms, reportStaleDisarms } from "../../policy";

/** When the re-arm pass first ran on this install: a disarm whose term ended before it is listed, not rewritten. */
export const REARM_SINCE_KEY = "lp.protection.rearm-since";

/**
 * The hourly safety net over ~/.lane-pilot/worktrees on every connected machine (WT1, 2026-10-30): copies of docs,
 * baseline, regress, self-repair and attempt worktrees used to sit for days — 12 GB on OVH, 3.5 GB on the mini —
 * when the pass that owned them ended without its removal path. Each host removes what no open attempt or live
 * pass holds, what is older than cleanup.worktree_grace_hours (default 2 h), what has no tracked edits and no
 * commits outside a non-lane ref; a copy with work nobody has is kept and named in the morning list. The hub sends
 * the protected paths because the decision needs its DB; the machine does the deleting.
 */

type JanitorOutcome = {
  removed?: string[]; freedBytes?: number;
  kept?: Array<{ path: string; reason: string; ageMs: number; bytes: number }>;
  tmpRemoved?: string[]; tmpFreedBytes?: number; errors?: string[];
};

export const JANITOR_OPEN_STATES: readonly string[] = OPEN_ATTEMPT_STATES;
/**
 * Ended attempts that can still go on in their own worktree: a writer question answered, a contract fixed in place or
 * a retry continues one. Their copy waits out the grace: magicseo T3.3 (2026-10-30) blocked on a question at
 * 18:13:58, the hourly reconcile removed its worktree at 18:14:02, and the reopened writer found no folder
 * (spawn /bin/bash ENOENT) and moved itself to the main checkout.
 */
export const JANITOR_REOPENABLE_STATES: readonly string[] = [...RETRY_ELIGIBLE, "blocked"];

/** cleanup.worktree_grace_hours in milliseconds (default 2 h). */
function worktreeGraceMs(db: ServerCore["db"]): number {
  const raw = configuredSetting(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID), "cleanup.worktree_grace_hours");
  return Math.max(0, (typeof raw === "number" ? raw : Number(raw) || 2) * 3_600_000);
}

/** The worktree paths live work still holds: open attempts and the copies the registry says are open. */
export async function protectedWorktreePaths(ctx: Pick<ServerCore, "bb" | "db">, now = Date.now()): Promise<Set<string>> {
  const { db } = ctx;
  const paths = new Set<string>();
  for (const p2 of attemptWorkspacePaths(db, JANITOR_OPEN_STATES)) paths.add(p2);
  for (const p2 of attemptWorkspacePaths(db, JANITOR_REOPENABLE_STATES, now - worktreeGraceMs(db))) paths.add(p2);
  // The registry is the primary source: every open row is a copy its process still owns. Copies the deployed build
  // made before the registry are adopted into it once at boot (adoptLegacyWorktrees), so no KV read lives here.
  for (const row of listOpenWorktrees(db)) paths.add(row.path);
  return paths;
}

/** One hourly pass: ask every connected machine to sweep, keep one receipt row per host for the morning list. */
/** The finished-attempt sweeps live in runs/server; the caller passes them in, since stability importing runs/server closes a module cycle. */
export type AttemptSweeps = { cleanupStickyLaneWorktrees: typeof import("../../runs/server").cleanupStickyLaneWorktrees; cleanupFinishedAttemptEnvironments: typeof import("../../runs/server").cleanupFinishedAttemptEnvironments };
export async function runWorktreeJanitor(ctx: Pick<ServerCore, "bb" | "db" | "log" | "isDisposed" | "host">, sweeps: AttemptSweeps, now = Date.now(), signal?: AbortSignal): Promise<{ removed: number; freedBytes: number; kept: number }> {
  const { bb, db } = ctx;
  const settings = loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID);
  if (configuredSetting(settings, "cleanup.worktrees") === "off") return { removed: 0, freedBytes: 0, kept: 0 };
  const graceRaw = configuredSetting(settings, "cleanup.worktree_grace_hours");
  const graceMs = Math.max(0, (typeof graceRaw === "number" ? graceRaw : Number(graceRaw) || 2) * 3_600_000);
  await ensureLegacyWorktreesAdopted(ctx);
  const protectedPaths = await protectedWorktreePaths(ctx, now);
  // The finished-attempt sweeps were never wired anywhere (found 2026-10-30: both exported, zero callers), which is why
  // lpattempt_* copies piled up; they run here, inside the janitor. `release` snapshots the work before the copy goes.
  const released = new Set<string>();
  const { cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees } = sweeps;
  const swept = await bestEffort(ctx.log, "sticky lane worktree sweep", cleanupStickyLaneWorktrees(db, async (hostId, basePath, worktreePath) => {
    const out = await ctx.host.call("gitRemoveWorktree", { requestedHostId: hostId, basePath, worktreePath, release: true }, { hostId, timeoutMs: 120_000 }).catch((cause: unknown) => { ctx.log(`Lane Pilot janitor: worktree removal on ${hostId} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; }) as { removed?: boolean } | null;
    return out?.removed === true;
  }, released, now, signal), [] as string[]);
  const snapshot = async (hostId: string, worktreePath: string, name: string) =>
    (await ctx.host.call("gitWorktreeSnapshot", { requestedHostId: hostId, worktreePath, name }, { hostId, timeoutMs: 120_000 })) as { status: "clean" | "saved" | "missing" | "failed"; path: string | null; reason: string | null };
  const envSwept = await bestEffort(ctx.log, "attempt environment sweep", cleanupFinishedAttemptEnvironments(bb, db, snapshot, now, signal), [] as string[]);
  // A protection switched off without renewal comes back when its term ends (SMA k_lib_stpa): on unless protection.rearm=off, for every
  // project with a disarm row. Disarms already expired when this pass first ran (marker in kv) are not rewritten: one owner item lists them.
  // Each project is its own try: one bad row never stops the pass or the host sweeps after it.
  const sinceRaw = await bb.storage.kv.get(REARM_SINCE_KEY).catch(() => null);
  const since = typeof sinceRaw === "number" ? sinceRaw : now;
  if (typeof sinceRaw !== "number") await bb.storage.kv.set(REARM_SINCE_KEY, now as never).catch((cause: unknown) => ctx.log(`Lane Pilot: protection re-arm marker not stored: ${cause instanceof Error ? cause.message : String(cause)}`));
  const rearmed: string[] = [];
  const projectsToCheck = (): string[] => { try { return switchOn(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID), "protection.rearm") ? disarmedProjects(db) : []; } catch (cause) { ctx.log(`Lane Pilot: protection re-arm could not list projects: ${cause instanceof Error ? cause.message : String(cause)}`); return []; } };
  for (const projectId of projectsToCheck()) {
    try {
      for (const key of rearmExpiredDisarms(db, projectId, now, since)) rearmed.push(`${projectId}:${key}`);
      reportStaleDisarms(db, projectId, since, now);
    } catch (cause) { ctx.log(`Lane Pilot: protection re-arm of project ${projectId} failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  for (const key of rearmed) ctx.log(`Lane Pilot: protection ${key} re-armed after its disarm term`);
  // Throwaway codex homes (SMA m_ac_codex_home) exist only where worker.strict_user is on, so a project without it costs no host call.
  // Only this sweep removes them: a task whose newest attempt is final and quiet for an hour, with no open attempt. The writer's own
  // thread may be resumed after any stop (a question to the PM, a feedback turn), so the end of an attempt removes nothing.
  const strictProjects = new Map<string, boolean>();
  let codexKeys: string[] = [];
  try {
    codexKeys = finalTaskIdsSince(db, now - 30 * 86_400_000, 300, now).flatMap((task) => {
      if (!strictProjects.has(task.projectId)) strictProjects.set(task.projectId, String(loadProjectSettings(db, task.projectId)[SETTING_WORKER_STRICT_USER] ?? "off") === "on");
      return strictProjects.get(task.projectId) ? task.keys : [];
    });
  } catch (cause) { ctx.log(`Lane Pilot janitor: codex home selection failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const hosts = await listQaHosts(bb);
  let removed = 0, freedBytes = 0, kept = 0;
  for (const machine of hosts.filter((row) => row.connected)) {
    if (ctx.isDisposed()) break;
    const out = await ctx.host.call("worktreeJanitor", { requestedHostId: machine.id, protectedPaths: [...protectedPaths], graceMs }, { hostId: machine.id, timeoutMs: 300_000 }).catch((cause: unknown) => { ctx.log(`Lane Pilot janitor on ${machine.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; }) as JanitorOutcome | null;
    if (!out) continue;
    const keptRows = out.kept ?? [];
    removed += out.removed?.length ?? 0;
    freedBytes += (out.freedBytes ?? 0) + (out.tmpFreedBytes ?? 0);
    kept += keptRows.length;
    for (const path of out.removed ?? []) releaseWorktreesUnder(db, machine.id, path, now);
    const keptJson = JSON.stringify(keptRows.slice(0, 50).map((row) => `${row.path} (${row.reason})`));
    // A pass that removed nothing and keeps the same list as the last one is no news: 347 identical rows a fortnight was the list before (audit 2026-11-14).
    const unchanged = !(out.removed?.length) && !(out.tmpRemoved?.length) && lastJanitorKept(db, machine.id, "hourly") === keptJson;
    if (!unchanged) {
      recordJanitorSweep(db, { at: now, host: machine.id, removed: out.removed?.length ?? 0, freedBytes: Math.round(out.freedBytes ?? 0), tmpRemoved: out.tmpRemoved?.length ?? 0, tmpFreedBytes: Math.round(out.tmpFreedBytes ?? 0), keptJson, pass: "hourly" });
      if (keptRows.length) ctx.log(`Lane Pilot janitor kept ${keptRows.length} worktree(s) on ${machine.name ?? machine.id}: ${keptRows.map((row) => `${row.path} (${row.reason})`).join(", ").slice(0, 400)}`);
    }
    for (const key of codexKeys) {
      if (ctx.isDisposed()) break;
      const gone = await ctx.host.call("removeWorkerHome", { requestedHostId: machine.id, key }, { hostId: machine.id, timeoutMs: 30_000 }).catch(() => null) as { removed?: boolean } | null;
      if (gone?.removed) removed += 1;
    }
  }
  return { removed: removed + swept.length + envSwept.length, freedBytes, kept };
}

type AttemptLivenessRow = { state: string; updated_at: number; area: string | null };
const ATTEMPT_LIVENESS_SQL = `SELECT a.state, a.updated_at, json_extract(t.contract_json,'$.area') AS area
  FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
  LEFT JOIN lane_pilot_task t ON t.id=a.task_id AND t.run_id=a.run_id`;

/** Whether one of these attempts still needs its worktree: at work, reopenable inside the grace, or a fresh sticky accept. */
function attemptHoldsWorktree(db: ServerCore["db"], attempts: AttemptLivenessRow[], now: number): boolean {
  return attempts.some((attempt) => isOpenAttemptState(attempt.state)
    || (JANITOR_REOPENABLE_STATES.includes(attempt.state) && now - attempt.updated_at < worktreeGraceMs(db))
    || (attempt.state === "accepted" && Boolean(attempt.area) && now - attempt.updated_at <= STICKY_WINDOW_MS));
}

/**
 * Whether a registry row's owning process is still alive. Each self-managed pass keeps the same liveness fact the
 * deployed build read — a docs reuse marker naming the copy, a fresh regress in-flight marker, a self-repair
 * record still holding it — so a pass that crashed before its release leaves a dead row the reconcile can reap.
 * An attempt is alive while it is at work, can still reopen inside the grace, or just accepted into a sticky
 * area; a copy any such attempt works in is alive whatever owner the row names. Every other owner is a bounded
 * pass with no liveness record, so its copy goes.
 */
async function ownerAlive(ctx: Pick<ServerCore, "bb" | "db">, row: { owner_kind: string; owner_id: string | null; created_at: number; host: string; path: string }, now = Date.now()): Promise<boolean> {
  const { bb, db } = ctx;
  if (row.owner_kind === "docs") {
    if (!row.owner_id) return false;
    const record = await bb.storage.kv.get(docsWorktreeKey(row.host, row.owner_id)) as { path?: string } | null;
    return record?.path === row.path;
  }
  if (row.owner_kind === "regress") {
    const entry = await bb.storage.kv.get(regressWorktreeKey(row.path)) as { hostId?: string; at?: number } | null;
    return entry?.hostId === row.host && typeof entry.at === "number" && now - entry.at < REGRESS_MARKER_TTL_MS;
  }
  if (row.owner_kind === "self-repair") {
    const repair = await bb.storage.kv.get(SELF_REPAIR_STATE_KEY);
    return selfRepairWorktrees(repair).some(({ worktree }) => worktree.hostId === row.host && worktree.path === row.path);
  }
  if (row.owner_kind !== "attempt") return false;
  // Sticky turns and retries borrow the original attempt's copy; the registry's creator is not its only owner.
  // Keep the creator too: its path may not be bound yet when a reload interrupts provisioning.
  const attempts = db.prepare(`${ATTEMPT_LIVENESS_SQL}
    WHERE a.id=? OR (a.workspace_path=? AND r.writer_host_id=?)`).all(row.owner_id, row.path, row.host) as AttemptLivenessRow[];
  return attemptHoldsWorktree(db, attempts, now);
}

/**
 * One-time adoption at boot: the deployed build kept pass worktrees only in the passes' own KV markers — docs reuse
 * keys (`docs-worktree:<host>:<name>`), in-flight regress keys (`regress-worktree:<path>`), the self-repair state
 * record (`self-repair:state`) — while the registry learned owners by worktree-name prefix. A copy made before the
 * registry (or whose row was lost) has no row, so the janitor could not protect or reconcile it. Each live marker
 * becomes an open registry row here; the passes keep owning their KV keys afterwards, and ownerAlive reads the row.
 */
export async function adoptLegacyWorktrees(ctx: Pick<ServerCore, "bb" | "db">, now = Date.now()): Promise<number> {
  const { bb, db } = ctx;
  const open = new Set((listOpenWorktrees(db).map((row) => ({ host: row.host, path: row.path })) as Array<{ host: string; path: string }>)
    .map((row) => JSON.stringify([row.host, row.path])));
  let adopted = 0;
  const adopt = (host: string | undefined, path: string | undefined, ownerKind: string, ownerId: string | null, branch: string | null = null, at?: number) => {
    if (!host || !path || open.has(JSON.stringify([host, path]))) return;
    registerWorktree(db, { host, path, branch, owner_kind: ownerKind, owner_id: ownerId }, at ?? now);
    open.add(JSON.stringify([host, path]));
    adopted += 1;
  };
  // docs: the durable reuse marker; host and name are the key's two segments (neither carries a colon).
  for (const key of await bb.storage.kv.list(DOCS_WORKTREE_PREFIX)) {
    const record = await bb.storage.kv.get(key) as { path?: string } | null;
    const [host, name] = key.slice(DOCS_WORKTREE_PREFIX.length).split(":");
    adopt(host, record?.path, "docs", name ?? null);
  }
  // regress: a bounded pass's in-flight copies; its own sweep drops markers older than six hours, so only fresh ones are live.
  for (const key of await bb.storage.kv.list(REGRESS_WORKTREE_PREFIX)) {
    const path = regressWorktreePath(key);
    const entry = await bb.storage.kv.get(key) as { hostId?: string; at?: number } | null;
    if (entry?.hostId && now - (entry.at ?? 0) < REGRESS_MARKER_TTL_MS) adopt(entry.hostId, path, "regress", path);
  }
  // self-repair: worktrees its state record still holds, pending respawns included.
  const repair = await bb.storage.kv.get(SELF_REPAIR_STATE_KEY);
  for (const { signature, worktree } of selfRepairWorktrees(repair)) {
    if (worktree.hostId && worktree.path) adopt(worktree.hostId, worktree.path, "self-repair", signature, worktree.branch ?? null);
  }
  return adopted;
}

const adoptedDatabases = new WeakSet<ServerCore["db"]>();
/**
 * Runs the one-time adoption once per database. The boot reconcile calls it after a short delay, but the hourly
 * janitor can fire first — and protectedWorktreePaths reads only the registry, so a legacy docs/regress/self-repair
 * copy would look unprotected and be deleted. The janitor run awaits this before computing protected paths.
 */
export async function ensureLegacyWorktreesAdopted(ctx: Pick<ServerCore, "bb" | "db">): Promise<void> {
  if (adoptedDatabases.has(ctx.db)) return;
  await adoptLegacyWorktrees(ctx);
  adoptedDatabases.add(ctx.db);
}

/** At plugin start (after a reload that killed every pass's finally): copies whose owner is dead go now, not hourly. */
export async function reconcileWorktreeRegistry(ctx: Pick<ServerCore, "bb" | "db" | "log" | "isDisposed" | "host">, now = Date.now()): Promise<number> {
  const { db } = ctx;
  const dead = (listOpenWorktrees(db) as Array<{ id: number; host: string; path: string; branch: string | null; owner_kind: string; owner_id: string | null; created_at: number }>);
  let removed = 0;
  for (const row of dead) {
    if (ctx.isDisposed()) break;
    if (await ownerAlive(ctx, row, now)) continue;
    // The host call needs the base checkout the copy came from; the attempt's run knows it, others take it from the worktree itself.
    const basePath = writerBaseForWorkspace(db, row.path) ?? row.path;
    const out = await ctx.host.call("gitRemoveWorktree", { requestedHostId: row.host, basePath, worktreePath: row.path, release: true }, { hostId: row.host, timeoutMs: 120_000 }).catch((cause: unknown) => { ctx.log(`Lane Pilot reconcile: worktree removal on ${row.host} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; }) as { removed?: boolean } | null;
    if (out?.removed === true) {
      releaseWorktreeById(db, row.id, now); removed++;
      // Removing a copy registered to another owner is a risky act: its checks go on record first (SMA k_lib_evidence).
      const saved = await recordEvidence(ctx.bb.storage.kv as never, {
        op: "janitor", projectId: row.owner_id ?? row.host, target: row.path,
        why: `copy of ${row.owner_kind} ${row.owner_id ?? "?"} whose owner is gone`,
        checks: [
          { name: "no open attempt or live pass holds it", ok: true },
          { name: "uncommitted work snapshotted before removal (release)", ok: true },
        ],
        by: "worktree-reconcile", at: now,
      });
      if (!saved) ctx.log(`Lane Pilot reconcile: evidence of ${row.path} not kept`);
    }
  }
  if (removed) ctx.log(`Lane Pilot reconcile: removed ${removed} worktree copies whose owner is gone`);
  return removed;
}

/**
 * At start: the copies a dead pass left go at once, with the same rules the hourly pass has (grace 0 for dead owners). The hourly and
 * the daily passes themselves are Lane Pilot's system schedules on the schedule board since 0.1.561 (graph lp.worktree-cleanup,
 * schedule/server/system-schedules.ts); until then the hourly one was a hidden `scheduleIsolated` job nobody saw on the board.
 */
export function mountWorktreeJanitor(ctx: ServerCore, _sweeps?: AttemptSweeps): void {
  const { bb } = ctx;
  const boot = setTimeout(() => { void (async () => { await ensureLegacyWorktreesAdopted(ctx); await reconcileWorktreeRegistry(ctx); })().catch((cause: unknown) => bb.log.info(`Lane Pilot reconcile failed: ${cause instanceof Error ? cause.message : String(cause)}`)); }, 45_000);
  bb.onDispose(() => clearTimeout(boot));
}

/** What one pass of the graph lp.worktree-cleanup reports: its status, the counts and one line for the board's run output. */
export type CleanupPassOutcome = { status: "ok" | "off" | "error"; removed: number; freedBytes: number; kept: number; report: string };

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;

/** The hourly pass: the registry's dead rows first, then Lane Pilot's root on every connected machine. */
export async function runHourlyWorktreePass(ctx: Pick<ServerCore, "bb" | "db" | "log" | "isDisposed" | "host">, sweeps: AttemptSweeps, now = Date.now(), signal?: AbortSignal): Promise<CleanupPassOutcome> {
  if (configuredSetting(loadProjectSettings(ctx.db, GLOBAL_SETTINGS_PROJECT_ID), "cleanup.worktrees") === "off") return { status: "off", removed: 0, freedBytes: 0, kept: 0, report: "cleanup.worktrees=off" };
  const reconciled = await bestEffort(ctx.log, "worktree registry reconcile", reconcileWorktreeRegistry(ctx, now), 0);
  const outcome = await runWorktreeJanitor(ctx, sweeps, now, signal);
  if (outcome.removed || outcome.kept) ctx.log(`Lane Pilot janitor: removed ${outcome.removed} worktree(s), freed ${Math.round(outcome.freedBytes / 1e6)} MB, kept ${outcome.kept}`);
  return { status: "ok", removed: outcome.removed + reconciled, freedBytes: outcome.freedBytes, kept: outcome.kept,
    report: `Удалено ${outcome.removed + reconciled} worktree, освобождено ${gb(outcome.freedBytes)}; оставлено ${outcome.kept}` };
}

/** cleanup.worktree_max_age_days in milliseconds (default 7 days, at least one). */
export function worktreeMaxAgeMs(db: ServerCore["db"]): number {
  const raw = configuredSetting(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID), "cleanup.worktree_max_age_days");
  const days = typeof raw === "number" ? raw : Number(raw);
  return Math.max(1, Number.isFinite(days) && days > 0 ? days : 7) * 86_400_000;
}
/** A worktree whose folder or branch moved within this window is never swept: another agent may be working in it right now. */
export const WORKTREE_YOUNG_MS = 24 * 3_600_000;
/** The owner's line of the daily pass: one per distinct kept list (`worktree-cleanup:<hash>`), never one per pass. */
export const CLEANUP_ITEM_PREFIX = "worktree-cleanup:";

type DeepReceipt = NonNullable<Awaited<ReturnType<typeof import("../../verification").sweepWorktreeClasses>>>;
type HostAnswer = JanitorOutcome & { deep?: DeepReceipt };

/**
 * What the hub knows about each machine for the daily pass: the project folders (BB's project sources, Lane Pilot's run folders), the BB
 * environment worktrees of Lane Pilot attempts, the worktrees of abandoned tasks, the registry's open rows. «Abandoned» is a path every
 * attempt of which has ended without being accepted — cancelled, or failed and followed by a later attempt of the task, or left in a run
 * that is closed — and was last touched more than a day ago.
 */
export async function dailyPassInputs(ctx: Pick<ServerCore, "bb" | "db">, now = Date.now()): Promise<{
  folders: Map<string, Set<string>>; bbEnvPaths: Map<string, Set<string>>; abandoned: Map<string, Set<string>>; registry: Map<string, string[]>; candidates: string[];
}> {
  const { bb, db } = ctx;
  const add = (map: Map<string, Set<string>>, host: string, path: string) => { if (host && path?.startsWith("/")) map.set(host, (map.get(host) ?? new Set()).add(path)); };
  const folders = new Map<string, Set<string>>(), bbEnvPaths = new Map<string, Set<string>>(), abandoned = new Map<string, Set<string>>();
  const projects = await (bb.sdk as unknown as { projects?: { list(query: unknown): Promise<Array<{ sources?: Array<{ hostId?: string; path?: string }> }>> } }).projects?.list({ includePersonal: true }).catch(() => []) ?? [];
  for (const project of projects) for (const source of project.sources ?? []) add(folders, source.hostId ?? "", source.path ?? "");
  const runs = recentRunWorkspaces(db, now - 90 * 86_400_000);
  const runFolders = new Set<string>();
  for (const run of runs) { add(folders, run.host, run.path); runFolders.add(`${run.host}\0${run.path}`); }
  const attempts = recentAttemptWorkspaces(db, now - 90 * 86_400_000);
  const byPath = new Map<string, typeof attempts>();
  for (const row of attempts) {
    const key = `${row.host}\0${row.path}`;
    byPath.set(key, [...(byPath.get(key) ?? []), row]);
    // A BB environment of an attempt: not Lane Pilot's own root (that class is `lane`), never a run's own folder or environment.
    if (row.env && row.env !== row.runEnv && !row.path.includes("/.lane-pilot/worktrees/") && !runFolders.has(key)) add(bbEnvPaths, row.host, row.path);
  }
  for (const [key, rows] of byPath) {
    if (runFolders.has(key)) continue;
    const ended = rows.every((row) => !isOpenAttemptState(row.state) && row.state !== "accepted");
    const given = rows.some((row) => row.state === "canceled" || row.runClosed !== null || row.later > 0);
    if (ended && given && Math.max(...rows.map((row) => row.updatedAt)) < now - WORKTREE_YOUNG_MS) add(abandoned, rows[0]!.host, rows[0]!.path);
  }
  const registry = new Map<string, string[]>();
  for (const row of listOpenWorktrees(db)) if (row.created_at < now - 3_600_000) registry.set(row.host, [...(registry.get(row.host) ?? []), row.path]);
  // The trees of a phase still in work: the phase driver made them (no registry row), the daily pass leaves them.
  const candidates: string[] = [];
  for (const phase of listPhases(db, { live: true, limit: 1000 })) {
    for (const tree of Object.values(phase.record.candidate?.trees ?? {}) as Array<{ path?: string }>) if (tree.path) candidates.push(tree.path);
  }
  return { folders, bbEnvPaths, abandoned, registry, candidates };
}

/**
 * The daily pass on every connected machine (docs/worktrees.md, SMA dt_wt_sweep): the hourly sweep plus every class in the project
 * repositories, `git worktree prune`, the registry rows whose folder is gone closed. One janitor row per machine (pass daily, with
 * kept_unmerged and the report by class) and one owner line for what a person has to look at — the copies kept for unmerged commits,
 * uncommitted changes or a live lock — posted once per distinct list, never once per pass.
 */
export async function runDailyWorktreePass(ctx: Pick<ServerCore, "bb" | "db" | "log" | "isDisposed" | "host">, now = Date.now(), options: { dryRun?: boolean } = {}): Promise<CleanupPassOutcome> {
  const { bb, db } = ctx;
  const settings = loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID);
  if (configuredSetting(settings, "cleanup.worktrees") === "off") return { status: "off", removed: 0, freedBytes: 0, kept: 0, report: "cleanup.worktrees=off" };
  const dryRun = options.dryRun === true;
  await ensureLegacyWorktreesAdopted(ctx);
  if (!dryRun) await bestEffort(ctx.log, "worktree registry reconcile", reconcileWorktreeRegistry(ctx, now), 0);
  const inputs = await dailyPassInputs(ctx, now);
  const protectedPaths = [...await protectedWorktreePaths(ctx, now), ...inputs.candidates];
  const maxAgeMs = worktreeMaxAgeMs(db);
  const hosts = (await listQaHosts(bb)).filter((row) => row.connected);
  let removed = 0, freedBytes = 0, kept = 0, keptUnmergedAll = 0, pruned = 0, closed = 0;
  const attention: Array<{ host: string; path: string; reason: string; detail: string; bytes: number }> = [];
  const branchesKept: string[] = [];
  const errors: string[] = [];
  for (const machine of hosts) {
    if (ctx.isDisposed()) break;
    const out = await ctx.host.call("worktreeJanitor", {
      requestedHostId: machine.id, protectedPaths, graceMs: worktreeGraceMs(db),
      deep: { folders: [...inputs.folders.get(machine.id) ?? []], bbEnvPaths: [...inputs.bbEnvPaths.get(machine.id) ?? []], abandonedPaths: [...inputs.abandoned.get(machine.id) ?? []],
        registryPaths: inputs.registry.get(machine.id) ?? [], maxAgeMs, youngMs: WORKTREE_YOUNG_MS, now: Math.round(now), ...(dryRun ? { dryRun: true } : {}) },
    }, { hostId: machine.id, timeoutMs: 30 * 60_000 }).catch((cause: unknown) => { errors.push(`${machine.name ?? machine.id}: ${cause instanceof Error ? cause.message : String(cause)}`); return null; }) as HostAnswer | null;
    if (!out) continue;
    const deep = out.deep;
    if (!deep) { errors.push(`${machine.name ?? machine.id}: this machine's Lane Pilot host has no daily pass yet (update the plugin there)`); continue; }
    if (!dryRun) {
      for (const row of deep.removed) closed += releaseWorktreesUnder(db, machine.id, row.path, now);
      for (const path of out.removed ?? []) closed += releaseWorktreesUnder(db, machine.id, path, now);
      for (const path of deep.registryGone) { const before = closed; closed += releaseWorktreesUnder(db, machine.id, path, now); if (closed === before) releaseWorktree(db, machine.id, path, now); }
    }
    const reported = deep.kept.filter((row) => (REPORTED_KEEP_REASONS as readonly string[]).includes(row.reason));
    const keptUnmerged = deep.kept.filter((row) => row.reason === "unmerged").length;
    const byClass: Record<string, { removed: number; freedBytes: number; kept: Record<string, number> }> = {};
    for (const row of deep.removed) { const entry = byClass[row.cls] ??= { removed: 0, freedBytes: 0, kept: {} }; entry.removed += 1; entry.freedBytes += row.bytes; }
    for (const row of deep.kept) { const entry = byClass[row.cls] ??= { removed: 0, freedBytes: 0, kept: {} }; entry.kept[row.reason] = (entry.kept[row.reason] ?? 0) + 1; }
    const hostRemoved = deep.removed.length + (out.removed?.length ?? 0);
    const hostFreed = deep.freedBytes + (out.freedBytes ?? 0) + (out.tmpFreedBytes ?? 0);
    removed += hostRemoved; freedBytes += hostFreed; kept += reported.length + (out.kept?.length ?? 0); keptUnmergedAll += keptUnmerged; pruned += deep.pruned;
    for (const row of reported) attention.push({ host: machine.name ?? machine.id, path: row.path, reason: row.reason, detail: row.detail, bytes: row.bytes });
    for (const row of deep.branchesKept) branchesKept.push(`${machine.name ?? machine.id}: ${row.branch} (${row.repo}) — ${row.reason}`);
    for (const error of [...deep.errors, ...(out.errors ?? [])]) errors.push(`${machine.name ?? machine.id}: ${error}`);
    if (!dryRun) recordJanitorSweep(db, {
      at: now, host: machine.id, pass: "daily", removed: hostRemoved, freedBytes: Math.round(deep.freedBytes + (out.freedBytes ?? 0)), tmpRemoved: out.tmpRemoved?.length ?? 0, tmpFreedBytes: Math.round(out.tmpFreedBytes ?? 0),
      keptJson: JSON.stringify(reported.slice(0, 50).map((row) => `${row.path} (${row.reason}: ${row.detail})`)), keptUnmerged,
      reportJson: JSON.stringify({ classes: byClass, pruned: deep.pruned, registryClosed: deep.registryGone.length, repos: deep.repos, branchesKept: deep.branchesKept.slice(0, 50),
        removed: deep.removed.slice(0, 100).map((row) => ({ path: row.path, cls: row.cls, bytes: row.bytes, branch: row.branch, branchDeleted: row.branchDeleted, why: row.why, how: row.how })), errors: deep.errors.slice(0, 20) }),
    });
  }
  const reasonWord: Record<string, string> = { unmerged: "невлитые коммиты", dirty: "незакоммиченные правки", locked: "заблокирована живым процессом", error: "не прочиталась" };
  const counts = Object.entries(attention.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.reason]: (acc[row.reason] ?? 0) + 1 }), {})).map(([reason, count]) => `${reasonWord[reason] ?? reason} ${count}`).join(", ");
  const report = `${dryRun ? "Пробный проход (ничего не удалено): было бы удалено" : "Удалено"} ${removed} worktree, освобождено ${gb(freedBytes)}; prune ${pruned}, закрыто строк реестра ${closed}; оставлено на проверку ${attention.length}${counts ? ` (${counts})` : ""}${branchesKept.length ? `; ветки с невлитыми коммитами оставлены: ${branchesKept.length}` : ""}${errors.length ? `; ошибки: ${errors.length}` : ""}`;
  if (!dryRun) postCleanupItem(db, attention, report, branchesKept, now);
  if (errors.length) ctx.log(`Lane Pilot daily worktree pass: ${errors.slice(0, 5).join("; ")}`);
  return { status: hosts.length && errors.length >= hosts.length && !removed ? "error" : "ok", removed, freedBytes, kept, report: [report, ...attention.slice(0, 20).map((row) => `- ${row.host}: ${row.path} — ${reasonWord[row.reason] ?? row.reason}: ${row.detail}`), ...branchesKept.slice(0, 10).map((line) => `- ${line}`), ...errors.slice(0, 10).map((line) => `- ошибка: ${line}`)].join("\n") };
}

/**
 * One owner line for the copies a person has to look at, keyed by the list itself: the same list tomorrow is the same open line (nothing
 * new on his screen), a changed list closes the old line and opens a new one, an empty list closes it. A line the owner closed himself
 * stays closed while the list is the same (postOwnerItem keeps his answer).
 */
function postCleanupItem(db: ServerCore["db"], attention: Array<{ host: string; path: string; reason: string; detail: string; bytes: number }>, report: string, branchesKept: string[], now: number): void {
  try {
    const lines = attention.map((row) => `${row.host}\t${row.path}\t${row.reason}`).sort();
    if (!lines.length) { closeOwnerItemsByPrefix(db, CLEANUP_ITEM_PREFIX, "janitor:worktree-cleanup", now); return; }
    const key = `${CLEANUP_ITEM_PREFIX}${createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 16)}`;
    if (hasOpenOwnerItem(db, { key })) return;
    for (const open of listOpenOwnerItemKeys(db, { source: "janitor", kind: "worktree_cleanup" }).filter((item) => item.startsWith(CLEANUP_ITEM_PREFIX) && item !== key)) closeOwnerItem(db, open, "janitor:worktree-cleanup", now);
    const read = { id: "read", label: "Прочитано", cli: rpcLine("owner_waiting_close", { key }), rpc: { method: "owner_waiting_close", input: { key } } };
    postOwnerItem(db, { key, source: "janitor", kind: "worktree_cleanup", projectId: null, wake: false, actions: [read],
      what: `Уборка worktree: ${attention.length} копий оставлены, их нужно разобрать вручную`,
      why: [report, ...attention.slice(0, 8).map((row) => `${row.host}: ${row.path} — ${row.detail}`), ...branchesKept.slice(0, 4)].join("\n"),
      evidence: [{ kind: "text", ref: "lane_pilot_janitor", label: "строки ежедневного прохода" }] }, now);
  } catch { /* the janitor rows and the run output have it */ }
}

/**
 * The code step of the graph lp.worktree-cleanup (the body of the two system schedules): `pass` hourly or daily, `dry_run` reads only.
 * A pass that throws ends `error` with the reason, so the board shows a failed run and its pause-after-N rule applies.
 */
export function registerWorktreeCleanupActions(engine: WorkflowEngine, ctx: Pick<ServerCore, "bb" | "db" | "log" | "isDisposed" | "host">, sweeps: AttemptSweeps): void {
  engine.register<ChainRuntime>("lp.worktree_cleanup", {
    reentrant: true,
    run: async (c) => {
      const pass = String(c.resolve("$inputs.pass") ?? "hourly") === "daily" ? "daily" : "hourly";
      try {
        const out = pass === "daily" ? await runDailyWorktreePass(ctx, Date.now(), { dryRun: c.resolve("$inputs.dry_run") === true }) : await runHourlyWorktreePass(ctx, sweeps, Date.now());
        return { output: { status: out.status, removed: out.removed, freed_bytes: Math.round(out.freedBytes), kept: out.kept, report: out.report.slice(0, 16_000) } };
      } catch (cause) {
        return { output: { status: "error", removed: 0, freed_bytes: 0, kept: 0, report: `the ${pass} pass stopped: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 2000) } };
      }
    },
  });
}
