import { memoryClaimIssue, parseMemorySettings, type MemoryCandidate, type MemorySettings } from "@lane-pilot/memory-core";
import { configuredSetting } from "../../contracts/server";

const MEMORY_KEYS = [
  "memory.enabled", "memory.maintain", "memory.inject", "memory.audience", "memory.personal_bot", "memory.search_engine",
  "memory.core_budget", "memory.note_budget", "memory.index_budget", "memory.context_budget",
  "memory.single_claim", "memory.tag_notes", "memory.judge.enabled", "memory.judge.model", "memory.judge.fallback_model", "memory.judge.timeout_ms", "memory.judge.candidates", "memory.vector_mode", "memory.door_lock", "memory.judge.mode", "memory.pinned",
];

/** The project's memory settings, read from the record the caller already holds. */
export function memorySettingsFor(settings: Record<string, unknown>): MemorySettings {
  return parseMemorySettings(Object.fromEntries(MEMORY_KEYS.map((key) => [key, configuredSetting(settings, key)])));
}

/** The maintainer's view of the same settings: it also reads how often it runs. memory.single_claim and memory.tag_notes are on when unset (a stored off opts out). */
export function maintainerMemorySettings(settings: Record<string, unknown>): MemorySettings {
  return parseMemorySettings(Object.fromEntries([...MEMORY_KEYS, "memory.maintain_every"].map((key) => [key, configuredSetting(settings, key)])));
}

/** memory.single_claim: a list packed into one record is dropped and the rest of the batch stays; with the setting off nothing is dropped. */
export function dropPackedLists<T extends Pick<MemoryCandidate, "content">>(entries: readonly T[], settings: Pick<MemorySettings, "singleClaim">): { kept: T[]; dropped: number } {
  const kept = settings.singleClaim ? entries.filter((entry) => !memoryClaimIssue(entry.content)) : [...entries];
  return { kept, dropped: entries.length - kept.length };
}
