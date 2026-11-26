import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRootFromModule } from "@lane-pilot/kit";

export function loadTaskV2Schema(): Record<string, unknown> {
  const path = join(pluginRootFromModule(import.meta.url), "lane-stack/schemas/task-v2.schema.json");
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
