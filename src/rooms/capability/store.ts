import type Database from "better-sqlite3";
import type { Capability, CapabilityReceipt, CapabilityState } from "./logic";

type Db = Pick<Database.Database, "prepare">;

export function saveReceipt(db: Db, row: CapabilityReceipt): void {
  db.prepare(`INSERT INTO lane_pilot_capability(provider_id,version,capability,state,model,detail,at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(provider_id,version,capability) DO UPDATE SET state=excluded.state, model=excluded.model, detail=excluded.detail, at=excluded.at`)
    .run(row.providerId, row.version, row.capability, row.state, row.model, row.detail, row.at);
}

export function listReceipts(db: Db): CapabilityReceipt[] {
  return (db.prepare("SELECT * FROM lane_pilot_capability ORDER BY provider_id, at").all() as Array<{ provider_id: string; version: string; capability: Capability; state: CapabilityState; model: string | null; detail: string | null; at: number }>)
    .map((row) => ({ providerId: row.provider_id, version: row.version, capability: row.capability, state: row.state, model: row.model, detail: row.detail, at: row.at }));
}
