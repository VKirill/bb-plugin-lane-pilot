import { DEFAULT_RELEVANCE_FLOOR, projectUsesSections, relevantRecords, resolveProjectKind, searchMemoryRecords, type MemoryRecord } from "@lane-pilot/memory-core";
import { memorySettingsFor } from "./memory-settings";
import { loadProjectSettings, projectHasScopedRun, type LanePilotDatabase } from "../../../storage";
import { listCoreMemoryForSession } from "../repositories/memory-queries";

export { listCoreMemoryForSession };

/**
 * The notes a session may be reminded of without asking anyone (the prompt recall and the subagent pack): confirmed, active, in
 * date, of the project's own root and the caller's sections, found by the word index alone (the "fts5" engine: no embedding call,
 * no answer gate, no model or network call, and no miss recorded). A note only one session vouches for, or one waiting out its 24 h
 * quarantine, never comes out; neither does anything while `memory.enabled` is off.
 */
export function confirmedWordHits(db: LanePilotDatabase, projectId: string, query: string, input: { chain?: readonly string[]; limit: number }): MemoryRecord[] {
  const chain = input.chain ?? [];
  const settings = memorySettingsFor(loadProjectSettings(db, projectId, [...chain]));
  if (!settings.enabled) return [];
  const found = searchMemoryRecords(db, projectId, query, Math.min(100, Math.max(40, input.limit * 4)), "fts5", "subagent", settings.personalBot,
    { includeObserved: false, chain, scopeMode: settings.scope ?? "section", umbrella: resolveProjectKind(settings.projectKind, projectUsesSections(db, projectId, projectHasScopedRun)) === "umbrella" });
  const floored = relevantRecords(db, projectId, query, found.filter((record) => record.trust === "confirmed"), { audience: "subagent", personalBot: settings.personalBot, floor: settings.queryFloor === false ? null : DEFAULT_RELEVANCE_FLOOR });
  return floored.slice(0, input.limit);
}
