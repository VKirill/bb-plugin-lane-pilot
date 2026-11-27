import type Database from "better-sqlite3";
import { hubFields, writeHubFields } from "../../../platform";
import { resolvePushConfig, validatePushPatch, type PushConfig } from "../../models/push-config";
import { listOwnerConfigRows, readOwnerConfigKey, writeOwnerConfigKey } from "../repositories/owner-push-repository";

export { readOwnerConfigKey, writeOwnerConfigKey };

type Db = Pick<Database.Database, "prepare" | "transaction">;

export function loadPushConfig(db: Pick<Database.Database, "prepare">): PushConfig {
  const rows = listOwnerConfigRows(db as Db);
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const own = hubFields(db, "owner_push") as Partial<PushConfig>;
  return resolvePushConfig(stored, own);
}

/** `enabled` on|off, `quiet` HH:MM-HH:MM ("" turns quiet hours off as 00:00-00:00), `timezone` an IANA name, `decision_cap` 0-50. */
export function savePushConfig(db: Db, patch: Record<string, string | undefined>, now: number = Date.now()): PushConfig {
  const { ownKeys, hubFields: fields } = validatePushPatch(patch);
  // Own-table keys: bell, dry_run, and decision_cap.
  for (const { key, value } of ownKeys) writeOwnerConfigKey(db, key, value, now);
  writeHubFields(db, "owner_push", fields, now);
  return loadPushConfig(db);
}
