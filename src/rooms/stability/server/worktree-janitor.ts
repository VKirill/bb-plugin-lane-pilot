import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { listQaHosts } from "../../platform/server";
import { scheduleIsolated } from "../../platform/server";
import { configuredSetting } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";
import { loadProjectSettings, registerWorktree } from "../../storage";
import { OPEN_ATTEMPT_STATES, RETRY_ELIGIBLE, isOpenAttemptState } from "../../contracts/state-machine";
import { STICKY_WINDOW_MS } from "../../platform/server";
import { DOCS_WORKTREE_PREFIX, docsWorktreeKey, REGRESS_MARKER_TTL_MS, REGRESS_WORKTREE_PREFIX, regressWorktreeKey, regressWorktreePath, SELF_REPAIR_STATE_KEY, selfRepairWorktrees } from "../../contracts/worktrees";
import { bestEffort } from "@lane-pilot/kit";

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
  const placeholders = JANITOR_OPEN_STATES.map(() => "?").join(",");
  for (const row of db.prepare(`SELECT workspace_path AS p FROM lane_pilot_attempt WHERE workspace_path IS NOT NULL AND state IN (${placeholders})`).all(...JANITOR_OPEN_STATES) as Array<{ p: string }>) paths.add(row.p);
  const reopenable = JANITOR_REOPENABLE_STATES.map(() => "?").join(",");
  for (const row of db.prepare(`SELECT workspace_path AS p FROM lane_pilot_attempt WHERE workspace_path IS NOT NULL AND state IN (${reopenable}) AND updated_at>=?`).all(...JANITOR_REOPENABLE_STATES, now - worktreeGraceMs(db)) as Array<{ p: string }>) paths.add(row.p);
  // The registry is the primary source: every open row is a copy its process still owns. Copies the deployed build
  // made before the registry are adopted into it once at boot (adoptLegacyWorktrees), so no KV read lives here.
  for (const row of db.prepare("SELECT path FROM lane_pilot_worktree WHERE released_at IS NULL").all() as Array<{ path: string }>) paths.add(row.path);
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
    db.prepare("INSERT INTO lane_pilot_janitor(at,host,removed,freed_bytes,tmp_removed,tmp_freed_bytes,kept_json) VALUES (?,?,?,?,?,?,?)")
      .run(now, machine.id, out.removed?.length ?? 0, Math.round(out.freedBytes ?? 0), out.tmpRemoved?.length ?? 0, Math.round(out.tmpFreedBytes ?? 0), JSON.stringify(keptRows.slice(0, 50).map((row) => `${row.path} (${row.reason})`)));
    if (keptRows.length) ctx.log(`Lane Pilot janitor kept ${keptRows.length} worktree(s) on ${machine.name ?? machine.id}: ${keptRows.map((row) => `${row.path} (${row.reason})`).join(", ").slice(0, 400)}`);
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
  const open = new Set((db.prepare("SELECT host, path FROM lane_pilot_worktree WHERE released_at IS NULL").all() as Array<{ host: string; path: string }>)
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
  const dead = (db.prepare("SELECT id,host,path,branch,owner_kind,owner_id,created_at FROM lane_pilot_worktree WHERE released_at IS NULL").all() as Array<{ id: number; host: string; path: string; branch: string | null; owner_kind: string; owner_id: string | null; created_at: number }>);
  let removed = 0;
  for (const row of dead) {
    if (ctx.isDisposed()) break;
    if (await ownerAlive(ctx, row, now)) continue;
    // The host call needs the base checkout the copy came from; the attempt's run knows it, others take it from the worktree itself.
    const known = db.prepare("SELECT writer_workspace_path AS p FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.workspace_path=? LIMIT 1").get(row.path) as { p?: string } | undefined;
    const basePath = known?.p ?? row.path;
    const out = await ctx.host.call("gitRemoveWorktree", { requestedHostId: row.host, basePath, worktreePath: row.path, release: true }, { hostId: row.host, timeoutMs: 120_000 }).catch((cause: unknown) => { ctx.log(`Lane Pilot reconcile: worktree removal on ${row.host} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; }) as { removed?: boolean } | null;
    if (out?.removed === true) { db.prepare("UPDATE lane_pilot_worktree SET released_at=? WHERE id=?").run(now, row.id); removed++; }
  }
  if (removed) ctx.log(`Lane Pilot reconcile: removed ${removed} worktree copies whose owner is gone`);
  return removed;
}

export function mountWorktreeJanitor(ctx: ServerCore, sweeps: AttemptSweeps): void {
  const { bb } = ctx;
  // After a reload: the copies a dead pass left go at once, with the same rules the hourly pass has (grace 0 for dead owners).
  const boot = setTimeout(() => { void (async () => { await ensureLegacyWorktreesAdopted(ctx); await reconcileWorktreeRegistry(ctx); })().catch((cause: unknown) => bb.log.info(`Lane Pilot reconcile failed: ${cause instanceof Error ? cause.message : String(cause)}`)); }, 45_000);
  bb.onDispose(() => clearTimeout(boot));
  scheduleIsolated(bb, "worktree-janitor", "14 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await bestEffort(bb.log, "worktree registry reconcile", reconcileWorktreeRegistry(ctx), 0);
    const outcome = await runWorktreeJanitor(ctx, sweeps, Date.now(), signal);
    if (outcome.removed || outcome.kept) bb.log.info(`Lane Pilot janitor: removed ${outcome.removed} worktree(s), freed ${Math.round(outcome.freedBytes / 1e6)} MB, kept ${outcome.kept}`);
  }, { timeoutMs: 10 * 60_000 });
}
