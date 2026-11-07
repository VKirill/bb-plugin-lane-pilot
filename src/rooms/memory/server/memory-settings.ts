import { parseMemorySettings, type MemorySettings } from "@lane-pilot/memory-core";
import { configuredSetting } from "../../contracts/server";

const MEMORY_KEYS = [
  "memory.enabled", "memory.maintain", "memory.inject", "memory.audience", "memory.personal_bot", "memory.search_engine",
  "memory.core_budget", "memory.note_budget", "memory.index_budget", "memory.context_budget",
];

/** The project's memory settings, read from the record the caller already holds. */
export function memorySettingsFor(settings: Record<string, unknown>): MemorySettings {
  return parseMemorySettings(Object.fromEntries(MEMORY_KEYS.map((key) => [key, configuredSetting(settings, key)])));
}
