import { memoryClaimIssue, parseMemorySettings, type MemoryCandidate, type MemorySettings } from "@lane-pilot/memory-core";
import { configuredSetting } from "../../../contracts/server";
import { MEMORY_SETTING_KEYS } from "../../settings";

const MEMORY_KEYS = [
  MEMORY_SETTING_KEYS.enabled,
  MEMORY_SETTING_KEYS.maintain,
  MEMORY_SETTING_KEYS.inject,
  MEMORY_SETTING_KEYS.audience,
  MEMORY_SETTING_KEYS.personalBot,
  MEMORY_SETTING_KEYS.searchEngine,
  MEMORY_SETTING_KEYS.coreBudget,
  MEMORY_SETTING_KEYS.noteBudget,
  MEMORY_SETTING_KEYS.indexBudget,
  MEMORY_SETTING_KEYS.contextBudget,
  MEMORY_SETTING_KEYS.singleClaim,
  MEMORY_SETTING_KEYS.tagNotes,
  MEMORY_SETTING_KEYS.judgeEnabled,
  MEMORY_SETTING_KEYS.judgeModel,
  MEMORY_SETTING_KEYS.judgeFallbackModel,
  MEMORY_SETTING_KEYS.judgeTimeoutMs,
  MEMORY_SETTING_KEYS.judgeCandidates,
  MEMORY_SETTING_KEYS.vectorMode,
  MEMORY_SETTING_KEYS.doorLock,
  MEMORY_SETTING_KEYS.judgeMode,
  MEMORY_SETTING_KEYS.pinned,
  MEMORY_SETTING_KEYS.scope,
];

/** The project's memory settings, read from the record the caller already holds. */
export function memorySettingsFor(settings: Record<string, unknown>): MemorySettings {
  return parseMemorySettings(Object.fromEntries(MEMORY_KEYS.map((key) => [key, configuredSetting(settings, key)])));
}

/** The maintainer's view of the same settings: it also reads how often it runs. memory.single_claim and memory.tag_notes are on when unset (a stored off opts out). */
export function maintainerMemorySettings(settings: Record<string, unknown>): MemorySettings {
  return parseMemorySettings(Object.fromEntries([...MEMORY_KEYS, MEMORY_SETTING_KEYS.maintainEvery].map((key) => [key, configuredSetting(settings, key)])));
}

/** memory.single_claim: a list packed into one record is dropped and the rest of the batch stays; with the setting off nothing is dropped. */
export function dropPackedLists<T extends Pick<MemoryCandidate, "content">>(entries: readonly T[], settings: Pick<MemorySettings, "singleClaim">): { kept: T[]; dropped: number } {
  const kept = settings.singleClaim ? entries.filter((entry) => !memoryClaimIssue(entry.content)) : [...entries];
  return { kept, dropped: entries.length - kept.length };
}
