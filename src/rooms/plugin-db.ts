// The plugin's composed database opener for tests and scripts: storage's whole surface with the migration
// list (src/rooms/migrations.ts) and the settings room's validator already applied. server.ts wires the same
// pieces explicitly through openDatabase(bb, { migrations, validateSetting }).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { openDatabase as openStorageDatabase } from "./storage/database";
import { migrations } from "./migrations";
import { validateSettingValue, validateSettingsObject } from "./settings";

export * from "./storage";
export * from "./storage/database";
export { migrations } from "./migrations";

export function openDatabase(bb: BbPluginApi) {
  return openStorageDatabase(bb, { migrations, validateSetting: { validateSettingValue, validateSettingsObject } });
}
