import { DEFAULT_RELEVANCE_FLOOR, relevantRecords, searchMemoryRecords, type MemoryRecord, type MemorySettings } from "@lane-pilot/memory-core";
import type { LanePilotDatabase } from "../../storage";
import { embedQuery } from "./embeddings";
import { judgeFound, translateForLock, type JudgeSurface } from "./memory-judge";
import { pinnedRecords, searchModeOptions } from "./memory-mix";

/**
 * The explicit memory search, whole: the question's vector and (door lock `translated`) its keyword translation, the search (word layer, vector
 * bridge or all-notes vectors, door lock), the relevance floor, the pinned records, then the judge (filter or rerank). The rpc `session_memory_search`
 * (so `bb lane-pilot memory search`) runs exactly this, and so does the ruler (`memory-eval --ruler`): one path, measured as it runs.
 * Every fork is a `memory.*` setting and the defaults are the search as it was before them.
 */
export type ExplicitSearch = { projectId: string; query: string; limit: number; memory: MemorySettings; chain?: readonly string[]; umbrella?: boolean;
  /** Every section of the project (the admin read): for a measurement over a copy of the hub, where sections are not the point. */
  allSections?: boolean; surface?: JudgeSurface };
export type ExplicitResult = { records: MemoryRecord[]; nothingRelevant: boolean; judged: boolean };

export async function explicitMemorySearch(db: LanePilotDatabase, input: ExplicitSearch): Promise<ExplicitResult> {
  const { projectId, query, memory } = input;
  const wanted = input.limit;
  // The floor drops records, so the search looks further than the limit to fill it; a query nothing clears gets the explicit «nothing» next to the empty list.
  await embedQuery(query);
  await translateForLock(query, memory);
  const scoped = { includeObserved: true, includeArchive: true, chain: input.chain ?? [], umbrella: input.umbrella ?? false, ...(input.allSections ? { allSections: true } : {}) };
  const found = searchMemoryRecords(db, projectId, query, Math.min(100, Math.max(40, wanted * 4)), memory.searchEngine, "subagent", memory.personalBot, { ...scoped, ...searchModeOptions(memory) });
  const floored = relevantRecords(db, projectId, query, found, { audience: "subagent", personalBot: memory.personalBot, floor: memory.queryFloor === false ? null : DEFAULT_RELEVANCE_FLOOR });
  const pins = pinnedRecords(db, projectId, memory, query, found, { ...scoped, scopeMode: memory.scope ?? "section" });
  const pinnedIds = new Set(pins.map((record) => record.id));
  const merged = pins.length ? [...pins, ...floored.filter((record) => !pinnedIds.has(record.id))] : floored;
  // The last stage (memory-judge.ts): a model names the notes that help, or only reorders them. Nothing is said about how sure the search was.
  const judged = await judgeFound(db, { projectId, query, found: merged, memory, surface: input.surface ?? "search", pinned: pinnedIds });
  const records = judged.records.slice(0, wanted);
  return { records, nothingRelevant: records.length === 0, judged: judged.judged };
}
