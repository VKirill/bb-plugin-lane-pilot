import type { PrototypeConfig } from "@lane-pilot/contracts";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { SettingValidationError } from "../setting-validation";
import { requireSettingValidator, type LanePilotDatabase } from "./database";

const CONFIG_KEYS = [
  "hostId", "pmWorkspacePath", "writerWorkspacePath", "pmProviderId",
  "pmModel", "writerProviderId", "writerModel",
] as const;

export function savePrototypeConfig(db: LanePilotDatabase, config: PrototypeConfig): void {
  const now = Date.now();
  const statement = db.prepare(`INSERT INTO lane_pilot_project_settings
    (project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,1,?)
    ON CONFLICT(project_id,binding_id,key) DO UPDATE SET
      value=excluded.value, version=lane_pilot_project_settings.version+1, updated_at=excluded.updated_at`);
  db.transaction(() => {
    for (const key of CONFIG_KEYS) {
      const nextVersion = getSettingVersions(db,config.projectId,[key])[key] + 1;
      statement.run(config.projectId, "", key, JSON.stringify(config[key]), now);
      db.prepare(`UPDATE lane_pilot_project_settings SET version=? WHERE project_id=? AND binding_id='' AND key=?`).run(nextVersion,config.projectId,key);
      bumpSettingGeneration(db,config.projectId,key,nextVersion);
    }
  })();
}

export type ImportedYaml = {
  routingProfile: { path: string; text: string; sha256: string } | null;
  nightShift: { path: string; text: string; sha256: string } | null;
};

export function importSettingsOnce(
  db: LanePilotDatabase,
  projectId: string,
  imported: ImportedYaml,
): { imported: boolean } {
  const existing = db.prepare(`SELECT key FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id='' AND key='import.completed'`).get(projectId);
  if (existing) return { imported: false };
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO lane_pilot_project_settings
    (project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,1,?)`);
  db.transaction(() => {
    insert.run(projectId, "", "import.routing_profile", JSON.stringify(imported.routingProfile), now);
    insert.run(projectId, "", "import.night_shift", JSON.stringify(imported.nightShift), now);
    insert.run(projectId, "", "import.completed", JSON.stringify({ at: now, version: 1 }), now);
  })();
  return { imported: true };
}

export function loadPrototypeConfig(db: LanePilotDatabase, projectId: string): PrototypeConfig | null {
  const rows = db.prepare(`SELECT key,value FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id=''`).all(projectId) as Array<{key:string; value:string}>;
  const values = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
  if (!CONFIG_KEYS.every((key) => typeof values[key] === "string" && values[key].length > 0)) return null;
  return { projectId, ...(values as Omit<PrototypeConfig, "projectId">) };
}

export function casSetting(
  db: LanePilotDatabase,
  args: { projectId: string; bindingId?: string; key: string; value: unknown; expectedVersion: number },
): boolean {
  const result = db.prepare(`UPDATE lane_pilot_project_settings
    SET value=?, version=version+1, updated_at=?
    WHERE project_id=? AND binding_id=? AND key=? AND version=?`).run(
      JSON.stringify(args.value), Date.now(), args.projectId, args.bindingId ?? "", args.key, args.expectedVersion,
    );
  return result.changes === 1;
}

/** Atomically claim a project-scoped daily schedule date; duplicate callbacks and plugin reloads are no-ops. */
export function claimDailySchedule(db:LanePilotDatabase, projectId:string, scheduleName:string, localDate:string):boolean {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scheduleName)) throw new Error("invalid schedule name");
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(localDate) ? new Date(`${localDate}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0,10) !== localDate) {
    throw new Error("invalid schedule date");
  }
  const key = `schedule.${scheduleName}.lastRunDate`;
  return db.transaction(() => {
    const current = db.prepare(`SELECT value,version FROM lane_pilot_project_settings
      WHERE project_id=? AND binding_id='' AND key=?`).get(projectId,key) as {value:string;version:number}|undefined;
    const value = JSON.stringify(localDate);
    const now = Date.now();
    if (!current) {
      return db.prepare(`INSERT OR IGNORE INTO lane_pilot_project_settings
        (project_id,binding_id,key,value,version,updated_at) VALUES (?,'',?,?,1,?)`).run(projectId,key,value,now).changes === 1;
    }
    if (current.value === value) return false;
    return db.prepare(`UPDATE lane_pilot_project_settings SET value=?,version=version+1,updated_at=?
      WHERE project_id=? AND binding_id='' AND key=? AND version=? AND value=?`)
      .run(value,now,projectId,key,current.version,current.value).changes === 1;
  }).immediate();
}

/** A section's settings live under binding_id "section:<id>"; the project's own under "". */
export function sectionBindingId(sectionId: string): string {
  return `section:${sectionId}`;
}

/** Project settings with each scope (outermost first) overriding the one above it. */
export function loadProjectSettings(db: LanePilotDatabase, projectId: string, scopes: readonly string[] = []): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const layers: Array<[string, string]> = [
    ...(projectId === GLOBAL_SETTINGS_PROJECT_ID ? [] : [[GLOBAL_SETTINGS_PROJECT_ID, ""] as [string, string]]),
    ...["", ...scopes].map((bindingId): [string, string] => [projectId, bindingId]),
  ];
  for (const [layerProjectId, bindingId] of layers) {
    const rows = db.prepare(`SELECT key,value FROM lane_pilot_project_settings
      WHERE project_id=? AND binding_id=?`).all(layerProjectId, bindingId) as Array<{key:string; value:string}>;
    for (const row of rows) {
      try { merged[row.key] = JSON.parse(row.value); } catch { merged[row.key] = row.value; }
    }
  }
  return merged;
}

export function saveProjectSetting(
  db: LanePilotDatabase,
  projectId: string,
  key: string,
  value: unknown,
): void {
  db.transaction(() => {
    const nextVersion = getSettingVersions(db,projectId,[key])[key] + 1;
    db.prepare(`INSERT INTO lane_pilot_project_settings
      (project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(project_id,binding_id,key) DO UPDATE SET
        value=excluded.value, version=excluded.version, updated_at=excluded.updated_at`)
      .run(projectId, "", key, JSON.stringify(value), nextVersion, Date.now());
    bumpSettingGeneration(db,projectId,key,nextVersion);
  })();
}

export function listSettingRows(db: LanePilotDatabase, projectId: string, bindingId = ""): Array<{
  key:string; value:unknown; version:number; updated_at:number;
}> {
  return (db.prepare(`SELECT s.key,s.value,COALESCE(g.version,s.version) AS version,s.updated_at FROM lane_pilot_project_settings s
    LEFT JOIN lane_pilot_setting_generation g ON g.project_id=s.project_id AND g.binding_id=s.binding_id AND g.key=s.key
    WHERE s.project_id=? AND s.binding_id=?`).all(projectId, bindingId) as Array<{
    key:string; value:string; version:number; updated_at:number;
  }>).map((row) => {
    let value: unknown = row.value;
    try { value = JSON.parse(row.value); } catch { /* keep text */ }
    return { key:row.key, value, version:row.version, updated_at:row.updated_at };
  });
}

export function getSettingVersions(db: LanePilotDatabase, projectId: string, keys: string[], bindingId = ""): Record<string, number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0]));
  if (!keys.length) return result;
  const placeholders = keys.map(() => "?").join(",");
  const rows = db.prepare(`SELECT key,version FROM lane_pilot_setting_generation WHERE project_id=? AND binding_id=? AND key IN (${placeholders})`).all(projectId,bindingId,...keys) as Array<{key:string;version:number}>;
  for (const row of rows) result[row.key] = row.version;
  return result;
}

function bumpSettingGeneration(db: LanePilotDatabase, projectId: string, key: string, version: number, bindingId = ""): void {
  db.prepare(`INSERT INTO lane_pilot_setting_generation(project_id,binding_id,key,version) VALUES (?,?,?,?)
    ON CONFLICT(project_id,binding_id,key) DO UPDATE SET version=excluded.version`).run(projectId,bindingId,key,version);
}

type CasUpsertSettingResult = { ok:true; version:number } | { ok:false; conflict:true; version:number; value:unknown }
  | { ok:false; conflict:false; version:number; value:unknown; validation:SettingValidationError };

/** The first error a save of `keys` would break; a validator without `validateSettingChanges` falls back to judging the changed keys and their coupled ones. */
function changeValidationError(
  validator: ReturnType<typeof requireSettingValidator>,
  keys: readonly string[],
  settings: Record<string, unknown>,
  skipKeys: readonly string[] = [],
): SettingValidationError | null {
  if (validator.validateSettingChanges) return validator.validateSettingChanges(keys, settings, skipKeys);
  const skipped = new Set(skipKeys);
  const relevant = new Set(keys.filter((key) => !skipped.has(key)));
  for (const key of relevant) for (const coupled of validator.coupledSettingKeys?.(key) ?? []) if (!skipped.has(coupled)) relevant.add(coupled);
  return validator.validateSettingsObject(settings).find((error) => relevant.has(error.key)) ?? null;
}

export function casUpsertSetting(
  db: LanePilotDatabase,
  args: { projectId:string; key:string; value:unknown; expectedVersion:number; bindingId?:string },
): CasUpsertSettingResult {
  const bindingId = args.bindingId ?? "";
  const save = db.transaction((): CasUpsertSettingResult => {
  const current = db.prepare(`SELECT value,version FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id=? AND key=?`).get(args.projectId, bindingId, args.key) as
    {value:string; version:number}|undefined;
  const version = getSettingVersions(db,args.projectId,[args.key],bindingId)[args.key];
  if (args.expectedVersion !== version) {
    let value: unknown = current?.value ?? null;
    if (current) {
      try { value = JSON.parse(current.value); } catch { /* keep stored text */ }
    }
    return { ok:false, conflict:true, version, value };
  }
  // A section's value is validated on top of its project's settings.
  const settings = loadProjectSettings(db, args.projectId, bindingId ? [bindingId] : []);
  settings[args.key] = args.value;
  // Only what this save changes is judged: the key itself and the keys the validator couples to it. An inherited value
  // that an older catalog no longer lists must not refuse every other save of the project.
  const validation = changeValidationError(requireSettingValidator(db), [args.key], settings);
  if (validation) {
    let value: unknown = current?.value ?? null;
    if (current) {
      try { value = JSON.parse(current.value); } catch { /* keep stored text */ }
    }
    return { ok:false, conflict:false, version, value, validation };
  }
  const nextVersion = version + 1;
  if (!current) {
    db.prepare(`INSERT INTO lane_pilot_project_settings
      (project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(args.projectId, bindingId, args.key, JSON.stringify(args.value), nextVersion, Date.now());
    bumpSettingGeneration(db,args.projectId,args.key,nextVersion,bindingId);
    return { ok:true, version:nextVersion };
  }
  if (!casSetting(db, { ...args, bindingId, expectedVersion:version })) {
    if (!current) return { ok:false, conflict:true, version:0, value:null };
    let value: unknown = current.value;
    try { value = JSON.parse(current.value); } catch { /* keep */ }
    return { ok:false, conflict:true, version:current.version, value };
  }
  bumpSettingGeneration(db,args.projectId,args.key,nextVersion,bindingId);
  const next = db.prepare(`SELECT version FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id=? AND key=?`).get(args.projectId, bindingId, args.key) as {version:number};
  return { ok:true, version:next.version };
  });
  return save.immediate();
}

export type SettingChange = { key:string; value:unknown; expectedVersion:number };
export type SaveSettingsResult = {
  ok:boolean;
  conflict:boolean;
  values:Record<string, unknown>;
  versions:Record<string, number>;
  validation?:SettingValidationError;
};

/** Compare, validate and persist a dependent setting group as one SQLite transaction. `skipValidationKeys` names keys the caller already validated (a role selection RPC checks its group against the live provider catalog). */
export function casUpsertSettings(
  db: LanePilotDatabase,
  args: { projectId:string; changes:SettingChange[]; bindingId?:string },
  options: { skipValidationKeys?: readonly string[] } = {},
): SaveSettingsResult {
  const bindingId = args.bindingId ?? "";
  const save = db.transaction((): SaveSettingsResult => {
    const keys = args.changes.map((change) => change.key);
    if (new Set(keys).size !== keys.length) {
      throw new Error("save_settings changes must contain unique keys");
    }
    const rows = db.prepare(`SELECT key,value,version FROM lane_pilot_project_settings
      WHERE project_id=? AND binding_id=?`).all(args.projectId, bindingId) as Array<{
        key:string; value:string; version:number;
      }>;
    // Values are validated on top of everything they inherit: global, project, then own rows.
    const settings: Record<string, unknown> = loadProjectSettings(db, args.projectId);
    const generations = getSettingVersions(db,args.projectId,keys,bindingId);
    const stored = new Map<string, { value:unknown; version:number }>();
    for (const row of rows) {
      let value: unknown = row.value;
      try { value = JSON.parse(row.value); } catch { /* keep stored text */ }
      settings[row.key] = value;
      stored.set(row.key, { value, version:generations[row.key] ?? row.version });
    }
    const snapshot = () => {
      const values: Record<string, unknown> = {};
      const versions: Record<string, number> = {};
      for (const key of keys) {
        values[key] = stored.get(key)?.value ?? null;
        versions[key] = generations[key] ?? 0;
      }
      return { values, versions };
    };
    if (args.changes.some((change) => (generations[change.key] ?? 0) !== change.expectedVersion)) {
      return { ok:false, conflict:true, ...snapshot() };
    }
    for (const change of args.changes) settings[change.key] = change.value;
    const validation = changeValidationError(requireSettingValidator(db), keys, settings, options.skipValidationKeys);
    if (validation) return { ok:false, conflict:false, ...snapshot(), validation };

    const now = Date.now();
    const insert = db.prepare(`INSERT INTO lane_pilot_project_settings
      (project_id,binding_id,key,value,version,updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`UPDATE lane_pilot_project_settings SET value=?, version=version+1, updated_at=?
      WHERE project_id=? AND binding_id=? AND key=?`);
    const values: Record<string, unknown> = {};
    const versions: Record<string, number> = {};
    for (const change of args.changes) {
      const nextVersion = change.expectedVersion + 1;
      if (!stored.has(change.key)) {
        insert.run(args.projectId, bindingId, change.key, JSON.stringify(change.value), nextVersion, now);
      } else {
        const result = update.run(JSON.stringify(change.value), now, args.projectId, bindingId, change.key);
        if (result.changes !== 1) throw new Error(`save_settings CAS changed during transaction: ${change.key}`);
      }
      bumpSettingGeneration(db,args.projectId,change.key,nextVersion,bindingId);
      versions[change.key] = nextVersion;
      values[change.key] = change.value;
    }
    return { ok:true, conflict:false, values, versions };
  });
  return save.immediate();
}

/** Remove explicit rows only after the validated snapshot still matches. Durable generations survive deletion. */
export function casResetSettings(
  db: LanePilotDatabase,
  args: { projectId: string; keys: string[]; expectedVersions: Record<string, number>; validationKeys: string[]; validatedRows: ReturnType<typeof listSettingRows>; bindingId?: string },
): SaveSettingsResult {
  const bindingId = args.bindingId ?? "";
  return db.transaction((): SaveSettingsResult => {
    const rows = listSettingRows(db, args.projectId, bindingId);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const values = Object.fromEntries(args.keys.map((key) => [key, byKey.get(key)?.value ?? null]));
    const versions = getSettingVersions(db,args.projectId,args.validationKeys,bindingId);
    const fingerprint = (items: typeof rows) => JSON.stringify(args.validationKeys.flatMap((key) => { const row = items.find((item) => item.key === key); return row ? [{ key: row.key, value: row.value, version: row.version }] : []; }).sort((a, b) => a.key.localeCompare(b.key)));
    if (args.keys.some((key) => versions[key] !== args.expectedVersions[key]) || fingerprint(rows) !== fingerprint(args.validatedRows)) {
      return { ok: false, conflict: true, values, versions };
    }
    const remove = db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id=? AND binding_id=? AND key=?");
    for (const key of args.keys) {
      remove.run(args.projectId, bindingId, key);
      const nextVersion = versions[key] + 1;
      bumpSettingGeneration(db,args.projectId,key,nextVersion,bindingId);
      versions[key] = nextVersion;
    }
    return { ok: true, conflict: false, values: Object.fromEntries(args.keys.map((key) => [key, null])), versions: Object.fromEntries(args.keys.map((key) => [key, versions[key]])) };
  })();
}

/** The settings a project or a section keeps for itself among those `isOverride` accepts: where a level overrides what it inherits. The global level is never listed. */
export function listOwnSettingLevels(db: LanePilotDatabase, isOverride: (key: string) => boolean): Array<{ projectId: string; sectionId: string | null; keys: string[] }> {
  const rows = db.prepare("SELECT project_id,binding_id,key FROM lane_pilot_project_settings WHERE project_id<>? ORDER BY project_id,binding_id,key")
    .all(GLOBAL_SETTINGS_PROJECT_ID) as Array<{ project_id: string; binding_id: string; key: string }>;
  const levels = new Map<string, { projectId: string; sectionId: string | null; keys: string[] }>();
  for (const row of rows.filter((item) => isOverride(item.key))) {
    const id = `${row.project_id}\0${row.binding_id}`;
    const level = levels.get(id) ?? { projectId: row.project_id, sectionId: row.binding_id.startsWith("section:") ? row.binding_id.slice("section:".length) : null, keys: [] };
    level.keys.push(row.key);
    levels.set(id, level);
  }
  return [...levels.values()];
}

/** Removes the accepted rows of the given levels in one transaction, as a reset does: the generations move on, so a save made on an older read conflicts. Returns how many rows went. */
export function removeOwnSettings(db: LanePilotDatabase, levels: ReadonlyArray<{ projectId: string; sectionId: string | null }>, isOverride: (key: string) => boolean): number {
  return db.transaction((): number => {
    let removed = 0;
    for (const { projectId, sectionId } of levels) {
      if (projectId === GLOBAL_SETTINGS_PROJECT_ID) continue;
      const bindingId = sectionId ? sectionBindingId(sectionId) : "";
      const keys = listSettingRows(db, projectId, bindingId).map((row) => row.key).filter(isOverride);
      const versions = getSettingVersions(db, projectId, keys, bindingId);
      for (const key of keys) {
        db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id=? AND binding_id=? AND key=?").run(projectId, bindingId, key);
        bumpSettingGeneration(db, projectId, key, versions[key]! + 1, bindingId);
        removed += 1;
      }
    }
    return removed;
  })();
}

/**
 * Removes every accepted row of `key` whose value is `value`, at every level (project, section, the global one), as a reset does: the generations
 * move on, so a save made on an older read conflicts. Returns the project ids that held such a row.
 */
export function clearSettingValue(db: LanePilotDatabase, key: string, value: string): string[] {
  return db.transaction((): string[] => {
    const rows = db.prepare("SELECT project_id, binding_id, value FROM lane_pilot_project_settings WHERE key=?").all(key) as Array<{ project_id: string; binding_id: string; value: string }>;
    const projects = new Set<string>();
    for (const row of rows) {
      let stored: unknown = row.value;
      try { stored = JSON.parse(row.value); } catch { /* the text itself */ }
      if (stored !== value) continue;
      const version = getSettingVersions(db, row.project_id, [key], row.binding_id)[key]!;
      db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id=? AND binding_id=? AND key=?").run(row.project_id, row.binding_id, key);
      bumpSettingGeneration(db, row.project_id, key, version + 1, row.binding_id);
      projects.add(row.project_id);
    }
    return [...projects];
  })();
}
