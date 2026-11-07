import type Database from "better-sqlite3";
import { listSettingRows, putGlobalSettingValue } from "../../storage";
import { GLOBAL_SETTINGS_PROJECT_ID, HUB_SPECS, fieldValue, hubSettingProblem, settingValue, specOf, type HubArea } from "@lane-pilot/settings-catalog";

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
    const stored = listSettingRows(db as never, GLOBAL_SETTINGS_PROJECT_ID);
    for (const row of stored) {
      if (!wanted.has(row.key)) continue;
      let value: unknown = row.value;
      try { value = JSON.parse(row.value as string); } catch { /* keep the text */ }
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
      if (putGlobalSettingValue(db as never, GLOBAL_SETTINGS_PROJECT_ID, key, JSON.stringify(value), now)) written.push(key);
    }
    return written;
  });
  return write.immediate();
}
