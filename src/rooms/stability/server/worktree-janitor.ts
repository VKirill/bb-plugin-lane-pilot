import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { mapListedQaHosts } from "../../qa";
import { scheduleIsolated, configuredSetting } from "../../core/server";
import type { ServerCore } from "../../core/server";
import { loadProjectSettings } from "../../storage";

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

export const JANITOR_OPEN_STATES = ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"];

/** The worktree paths live work still holds: open attempts, the docs pass's KV record, regress's, self-repair's. */
export async function protectedWorktreePaths(ctx: Pick<ServerCore, "bb" | "db">): Promise<Set<string>> {
  const { bb, db } = ctx;
  const paths = new Set<string>();
  const placeholders = JANITOR_OPEN_STATES.map(() => "?").join(",");
  for (const row of db.prepare(`SELECT workspace_path AS p FROM lane_pilot_attempt WHERE workspace_path IS NOT NULL AND state IN (${placeholders})`).all(...JANITOR_OPEN_STATES) as Array<{ p: string }>) paths.add(row.p);
  for (const key of await bb.storage.kv.list("docs-worktree:").catch(() => [] as string[])) {
    const record = await bb.storage.kv.get(key).catch(() => null) as { path?: string } | null;
    if (record?.path) paths.add(record.path);
  }
  // A regress pass is bounded by four hours; its KV marker older than six is a leftover the pass itself would drop (regress.ts LEFTOVER_AFTER_MS).
  for (const key of await bb.storage.kv.list("regress-worktree:").catch(() => [] as string[])) {
    const entry = await bb.storage.kv.get(key).catch(() => null) as { at?: number } | null;
    if (Date.now() - (entry?.at ?? 0) < 6 * 3_600_000) paths.add(key.slice("regress-worktree:".length));
  }
  const repair = await bb.storage.kv.get("self-repair:state").catch(() => null) as { signatures?: Record<string, { worktree?: { path?: string } | null; pending?: { worktree?: { path?: string } } | null }> } | null;
  for (const record of Object.values(repair?.signatures ?? {})) {
    if (record?.worktree?.path) paths.add(record.worktree.path);
    if (record?.pending?.worktree?.path) paths.add(record.pending.worktree.path);
  }
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
  const protectedPaths = await protectedWorktreePaths(ctx);
  // The finished-attempt sweeps were never wired anywhere (found 2026-10-30: both exported, zero callers), which is why
  // lpattempt_* copies piled up; they run here, inside the janitor. `release` snapshots the work before the copy goes.
  const released = new Set<string>();
  const { cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees } = sweeps;
  const swept = await cleanupStickyLaneWorktrees(db, async (hostId, basePath, worktreePath) => {
    const out = await ctx.host.call("gitRemoveWorktree", { requestedHostId: hostId, basePath, worktreePath, release: true }, { hostId, timeoutMs: 120_000 }).catch(() => null) as { removed?: boolean } | null;
    return out?.removed === true;
  }, released, now, signal).catch(() => [] as string[]);
  const snapshot = async (hostId: string, worktreePath: string, name: string) =>
    (await ctx.host.call("gitWorktreeSnapshot", { requestedHostId: hostId, worktreePath, name }, { hostId, timeoutMs: 120_000 })) as { status: "clean" | "saved" | "missing" | "failed"; path: string | null; reason: string | null };
  const envSwept = await cleanupFinishedAttemptEnvironments(bb, db, snapshot, now, signal).catch(() => [] as string[]);
  const hosts = mapListedQaHosts(await (bb.sdk as unknown as { hosts: { list: () => Promise<unknown> } }).hosts.list().catch(() => []));
  let removed = 0, freedBytes = 0, kept = 0;
  for (const machine of hosts.filter((row) => row.connected)) {
    if (ctx.isDisposed()) break;
    const out = await ctx.host.call("worktreeJanitor", { requestedHostId: machine.id, protectedPaths: [...protectedPaths], graceMs }, { hostId: machine.id, timeoutMs: 300_000 }).catch(() => null) as JanitorOutcome | null;
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

export function mountWorktreeJanitor(ctx: ServerCore, sweeps: AttemptSweeps): void {
  const { bb } = ctx;
  scheduleIsolated(bb, "worktree-janitor", "14 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const outcome = await runWorktreeJanitor(ctx, sweeps, Date.now(), signal);
    if (outcome.removed || outcome.kept) bb.log.info(`Lane Pilot janitor: removed ${outcome.removed} worktree(s), freed ${Math.round(outcome.freedBytes / 1e6)} MB, kept ${outcome.kept}`);
  }, { timeoutMs: 10 * 60_000 });
}
