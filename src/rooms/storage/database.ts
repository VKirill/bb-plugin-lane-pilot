import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { SettingsValidator } from "../setting-validation";
import packageJson from "../../../package.json";

export type LanePilotDatabase = Database.Database;

/** The Lane Pilot version that creates attempts; stored on each attempt (harness_version) to tell which build ran it. */
export const HARNESS_VERSION: string = packageJson.version;

const settingValidators = new WeakMap<LanePilotDatabase, SettingsValidator>();

/** The settings validator of this database; setting writes need one — openDatabase wires it. */
export function requireSettingValidator(db: LanePilotDatabase): SettingsValidator {
  const validator = settingValidators.get(db);
  if (!validator) throw new Error("setting writes need a validator — open the database with openDatabase(bb, { migrations, validateSetting })");
  return validator;
}

export function openDatabase(bb: BbPluginApi, options: { migrations: readonly string[]; validateSetting?: SettingsValidator }): LanePilotDatabase {
  const db = bb.storage.database();
  db.pragma("foreign_keys = ON");
  bb.storage.migrate(db, [...options.migrations]);
  if (options.validateSetting) settingValidators.set(db, options.validateSetting);
  return db;
}
