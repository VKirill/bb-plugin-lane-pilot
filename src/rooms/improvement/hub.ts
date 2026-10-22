import type Database from "better-sqlite3";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { HUB_SPECS, fieldValue, hubSettingProblem, settingValue, specOf, type HubArea } from "./keys";

/**
 * The global-level rows behind the self-improvement controls, read and written with plain SQL so the rooms that own the old stores (wall,
 * bench, owner-waiting, harness) need no more than a database handle. The write keeps the setting's version in step with `save_setting`
 * (`lane_pilot_setting_generation`), so a screen that saved a field before sees the CLI's change as a newer version, not a silent overwrite.
 */
export type HubDb = Pick<Database.Database, "prepare" | "transaction">;
type ReadDb = Pick<Database.Database, "prepare">;

/** Every stored global row for the given keys (or all hub keys); a missing table (an old database) is no rows. */
export function readHubRows(db: ReadDb, keys?: readonly string[]): Map<string, { value: unknown; version: number }> {
  const wanted = new Set(keys ?? HUB_SPECS.map((spec) => spec.key));
  const rows = new Map<string, { value: unknown; version: number }>();
  try {
    const stored = db.prepare(`SELECT s.key AS key, s.value AS value, COALESCE(g.version, s.version) AS version FROM lane_pilot_project_settings s
      LEFT JOIN lane_pilot_setting_generation g ON g.project_id=s.project_id AND g.binding_id=s.binding_id AND g.key=s.key
      WHERE s.project_id=? AND s.binding_id=''`).all(GLOBAL_SETTINGS_PROJECT_ID) as Array<{ key: string; value: string; version: number }>;
    for (const row of stored) {
      if (!wanted.has(row.key)) continue;
      let value: unknown = row.value;
      try { value = JSON.parse(row.value); } catch { /* keep the text */ }
      rows.set(row.key, { value, version: row.version });
    }
  } catch { /* no settings table yet */ }
  return rows;
}

/** The fields of one area that have a row, under the names of the area's old config object. A value the area cannot use is left out. */
export function hubFields(db: ReadDb, area: HubArea): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const specs = HUB_SPECS.filter((spec) => spec.area === area);
  const rows = readHubRows(db, specs.map((spec) => spec.key));
  for (const spec of specs) {
    const row = rows.get(spec.key);
    if (!row || hubSettingProblem(spec.key, row.value) || row.value === "" || row.value === null) continue;
    const value = fieldValue(spec, row.value);
    if (value !== undefined) out[spec.field] = value;
  }
  return out;
}

/** Writes fields of one area (old config names) as global rows. Returns the settings that changed. */
export function writeHubFields(db: HubDb, area: HubArea, patch: Record<string, unknown>, now: number = Date.now()): string[] {
  const changes: Array<[string, unknown]> = [];
  for (const spec of HUB_SPECS.filter((item) => item.area === area)) {
    if (!(spec.field in patch) || patch[spec.field] === undefined) continue;
    changes.push([spec.key, settingValue(spec, patch[spec.field])]);
  }
  return writeHubSettings(db, changes, now);
}

/** Writes settings by key. A value that fails `hubSettingProblem` throws with the reason, before anything is written. */
export function writeHubSettings(db: HubDb, changes: ReadonlyArray<readonly [string, unknown]>, now: number = Date.now()): string[] {
  for (const [key, value] of changes) {
    if (!specOf(key)) throw new Error(`${key} is not a self-improvement setting`);
    const problem = hubSettingProblem(key, value);
    if (problem || value === undefined || value === null || value === "") throw new Error(`invalid value for ${key}; allowed: ${problem ?? "a value"}`);
  }
  const write = db.transaction((): string[] => {
    const written: string[] = [];
    for (const [key, value] of changes) {
      const text = JSON.stringify(value);
      const current = db.prepare("SELECT value, version FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?").get(GLOBAL_SETTINGS_PROJECT_ID, key) as { value: string; version: number } | undefined;
      if (current?.value === text) continue;
      const generation = db.prepare("SELECT version FROM lane_pilot_setting_generation WHERE project_id=? AND binding_id='' AND key=?").get(GLOBAL_SETTINGS_PROJECT_ID, key) as { version: number } | undefined;
      const next = (generation?.version ?? current?.version ?? 0) + 1;
      if (current) db.prepare("UPDATE lane_pilot_project_settings SET value=?, version=?, updated_at=? WHERE project_id=? AND binding_id='' AND key=?").run(text, next, now, GLOBAL_SETTINGS_PROJECT_ID, key);
      else db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,?,?)").run(GLOBAL_SETTINGS_PROJECT_ID, "", key, text, next, now);
      db.prepare(`INSERT INTO lane_pilot_setting_generation(project_id,binding_id,key,version) VALUES (?,?,?,?)
        ON CONFLICT(project_id,binding_id,key) DO UPDATE SET version=excluded.version`).run(GLOBAL_SETTINGS_PROJECT_ID, "", key, next);
      written.push(key);
    }
    return written;
  });
  return write.immediate();
}
