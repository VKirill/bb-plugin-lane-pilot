// The plugin's composed database opener for tests and scripts: storage's whole surface with the migration
// list (src/rooms/migrations.ts) already applied. server.ts passes the same list to storage's openDatabase explicitly.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { openDatabase as openStorageDatabase } from "./storage/database";
import { migrations } from "./migrations";

export * from "./storage";
export * from "./storage/database";
export { migrations } from "./migrations";

export function openDatabase(bb: BbPluginApi) {
  return openStorageDatabase(bb, migrations);
}
