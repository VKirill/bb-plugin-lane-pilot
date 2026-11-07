import type { LanePilotDatabase } from "./database";

/** WT2 registry: one row per Lane Pilot worktree copy, written by the host.call wrapper (server side, one place). */
export type WorktreeOwnerKind = "attempt" | "docs" | "baseline" | "regress" | "self-repair" | "rollback" | "phase" | "unknown";
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
