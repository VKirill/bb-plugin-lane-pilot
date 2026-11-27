import type Database from "better-sqlite3";
import { tableExists } from "./owner-item-repository";

type Db = Pick<Database.Database, "prepare" | "transaction">;

export function listOwnerConfigRows(db: Db): Array<{ key: string; value: string }> {
  if (!tableExists(db, "lane_pilot_owner_config")) return [];
  return db.prepare("SELECT key, value FROM lane_pilot_owner_config").all() as Array<{ key: string; value: string }>;
}

export function hasOwnerConfigKey(db: Db, key: string): boolean {
  if (!tableExists(db, "lane_pilot_owner_config")) return false;
  return db.prepare("SELECT 1 FROM lane_pilot_owner_config WHERE key=?").get(key) !== undefined;
}

export function insertIgnoreOwnerConfigKey(db: Db, key: string, value: string, now: number): void {
  if (!tableExists(db, "lane_pilot_owner_config")) return;
  db.prepare("INSERT OR IGNORE INTO lane_pilot_owner_config(key,value,updated_at) VALUES (?,?,?)").run(key, value, now);
}

/** One key of the room's own key/value table (the reports room keeps «the daily report went out on this day» here). */
export function readOwnerConfigKey(db: Db, key: string): string | null {
  if (!tableExists(db, "lane_pilot_owner_config")) return null;
  return (db.prepare("SELECT value FROM lane_pilot_owner_config WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
}

export function writeOwnerConfigKey(db: Db, key: string, value: string, now: number = Date.now()): void {
  if (!tableExists(db, "lane_pilot_owner_config")) return;
  db.prepare("INSERT INTO lane_pilot_owner_config(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(key, value, now);
}

export function listOwnerPushRows(db: Db): Array<{ key: string; pushed_at: number }> {
  return db.prepare("SELECT key, pushed_at FROM lane_pilot_owner_push").all() as Array<{ key: string; pushed_at: number }>;
}

export function listOwnerPushKeys(db: Db): string[] {
  return (db.prepare("SELECT key FROM lane_pilot_owner_push").all() as Array<{ key: string }>).map((row) => row.key);
}

export function hasAnyBellPush(db: Db): boolean {
  return db.prepare("SELECT 1 FROM lane_pilot_owner_push WHERE key LIKE 'bell:%' LIMIT 1").get() !== undefined;
}

export function countBellPushedSince(db: Db, since: number): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM lane_pilot_owner_push WHERE key LIKE 'bell:%' AND pushed_at >= ?").get(since) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

export function deleteBellPushedBefore(db: Db, cutoff: number): void {
  db.prepare("DELETE FROM lane_pilot_owner_push WHERE key LIKE 'bell:%' AND pushed_at < ?").run(cutoff);
}

export function insertIgnoreOwnerPush(db: Db, key: string, pushedAt: number): number {
  return db.prepare("INSERT OR IGNORE INTO lane_pilot_owner_push(key,pushed_at) VALUES (?,?)").run(key, pushedAt).changes;
}
