import type { LanePilotDatabase } from "./database";

/** WT2 registry: one row per Lane Pilot worktree copy, written by the host.call wrapper (server side, one place). */
export type WorktreeOwnerKind = "attempt" | "docs" | "baseline" | "regress" | "self-repair" | "rollback" | "phase" | "check" | "unknown";
export type WorktreeRow = { id: number; host: string; path: string; branch: string | null; owner_kind: WorktreeOwnerKind; owner_id: string | null; created_at: number; released_at: number | null };
export type WorktreeOwner = { kind: WorktreeOwnerKind; id: string | null };

const WORKTREE_OWNER_KINDS: readonly string[] = ["attempt", "docs", "baseline", "regress", "self-repair", "rollback", "phase", "unknown"];
/** The owner a `gitCreateWorktree` caller declared in the call's `worktreeOwner` option; anything malformed is no declaration. */
export function declaredWorktreeOwner(value: unknown): WorktreeOwner | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = Reflect.get(value, "kind");
  const id = Reflect.get(value, "id");
  if (typeof kind !== "string" || !WORKTREE_OWNER_KINDS.includes(kind)) return null;
  return { kind: kind as WorktreeOwnerKind, id: typeof id === "string" ? id : null };
}

export function registerWorktree(db: LanePilotDatabase, row: { host: string; path: string; branch: string | null; owner_kind: string; owner_id: string | null }, at = Date.now()): void {
  db.prepare("INSERT INTO lane_pilot_worktree(host,path,branch,owner_kind,owner_id,created_at,released_at) VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(host,path) WHERE released_at IS NULL DO NOTHING")
    .run(row.host, row.path, row.branch, row.owner_kind, row.owner_id, at);
}

export function releaseWorktree(db: LanePilotDatabase, host: string, path: string, at = Date.now()): void {
  db.prepare("UPDATE lane_pilot_worktree SET released_at=? WHERE host=? AND path=? AND released_at IS NULL").run(at, host, path);
}

export function listOpenWorktrees(db: LanePilotDatabase): WorktreeRow[] {
  return db.prepare("SELECT id,host,path,branch,owner_kind,owner_id,created_at,released_at FROM lane_pilot_worktree WHERE released_at IS NULL").all() as WorktreeRow[];
}

/**
 * One janitor pass's receipt row per host (the morning list reads these). `pass` is hourly or daily (docs/worktrees.md); the daily row
 * carries how many copies stayed for commits merged nowhere and the pass's report by class (`report_json`: removed, kept by reason, pruned,
 * registry rows closed, branches kept). Columns added in 0.1.561 are additive: an older row reads as an hourly pass.
 */
export function recordJanitorSweep(db: LanePilotDatabase, row: { at: number; host: string; removed: number; freedBytes: number; tmpRemoved: number; tmpFreedBytes: number; keptJson: string;
  pass?: "hourly" | "daily"; keptUnmerged?: number; reportJson?: string | null }): void {
  db.prepare("INSERT INTO lane_pilot_janitor(at,host,removed,freed_bytes,tmp_removed,tmp_freed_bytes,kept_json,pass,kept_unmerged,report_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(row.at, row.host, row.removed, row.freedBytes, row.tmpRemoved, row.tmpFreedBytes, row.keptJson, row.pass ?? "hourly", row.keptUnmerged ?? 0, row.reportJson ?? null);
}

/** The kept list of a host's newest row of a pass: an hourly pass that removed nothing and keeps the same list writes no new row. */
export function lastJanitorKept(db: LanePilotDatabase, host: string, pass: "hourly" | "daily"): string | null {
  const row = db.prepare("SELECT kept_json FROM lane_pilot_janitor WHERE host=? AND pass=? ORDER BY at DESC, id DESC LIMIT 1").get(host, pass) as { kept_json: string } | undefined;
  return row?.kept_json ?? null;
}

/** Closes the open registry rows of a removed worktree: the row's path is the worktree or a folder inside it (a nested workspace). */
export function releaseWorktreesUnder(db: LanePilotDatabase, host: string, top: string, at = Date.now()): number {
  return db.prepare("UPDATE lane_pilot_worktree SET released_at=? WHERE host=? AND released_at IS NULL AND (path=? OR substr(path,1,?)=?)")
    .run(at, host, top, top.length + 1, `${top}/`).changes;
}

/** Mark one registry row released (the reconcile removed the copy on the host). */
export function releaseWorktreeById(db: LanePilotDatabase, id: number, at: number): void {
  db.prepare("UPDATE lane_pilot_worktree SET released_at=? WHERE id=?").run(at, id);
}
