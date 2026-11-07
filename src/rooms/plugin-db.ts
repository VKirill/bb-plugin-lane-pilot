// The plugin's composed database opener for tests and scripts: storage's whole surface with the migration
// list (src/rooms/migrations.ts) and the settings room's validator already applied. server.ts wires the same
// pieces explicitly through openDatabase(bb, { migrations, validateSetting }).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { openDatabase as openStorageDatabase } from "./storage";
import { migrations } from "./migrations";
import { coupledSettingKeys, validateSettingChanges, validateSettingValue, validateSettingsObject } from "./settings";
import { wireMemoryAttemptEffects } from "./memory/server/attempt-effects";

export * from "./storage";
export { migrations } from "./migrations";

export function openDatabase(bb: BbPluginApi) {
  const db = openStorageDatabase(bb, { migrations, validateSetting: { validateSettingValue, validateSettingsObject, coupledSettingKeys, validateSettingChanges } });
  wireMemoryAttemptEffects(db);
  return db;
}
