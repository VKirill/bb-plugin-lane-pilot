import type Database from "better-sqlite3";
import type { Outage } from "./logic";

type Db = Pick<Database.Database, "prepare">;
export type OutageRecord = Outage & { id: number; cause: string | null; noticedAt: number };

export function insertOutage(db: Db, outage: Outage, cause: string | null, now: number): void {
  db.prepare("INSERT INTO lane_pilot_outage(from_at,to_at,minutes,cause,noticed_at) VALUES (?,?,?,?,?)").run(outage.fromAt, outage.toAt, outage.minutes, cause, now);
}

export function listOutages(db: Db, since: number): OutageRecord[] {
  return (db.prepare("SELECT * FROM lane_pilot_outage WHERE to_at >= ? ORDER BY from_at").all(since) as Array<{ id: number; from_at: number; to_at: number; minutes: number; cause: string | null; noticed_at: number }>)
    .map((row) => ({ id: row.id, fromAt: row.from_at, toAt: row.to_at, minutes: row.minutes, cause: row.cause, noticedAt: row.noticed_at }));
}
