import { MEMORY_SETTING_KEYS, REVIEWER_CONCEPTS, estimateTokens, listMemory, memoryContext, parseMemorySettings, searchMemoryRecords, type MemorySearchEngine, type MemorySettings } from "@lane-pilot/memory-core";
import type { TaskV2 } from "../../contracts";
import { getRunSettingsScopes, loadProjectSettings, type LanePilotDatabase } from "../../storage";
import { memoryLine, reviewerMemoryPicks, writerMemory, writerMemoryPicks } from "../../writer";
import { configuredSetting } from "../../core/server";

type TaskPaths = Pick<TaskV2, "owns_paths" | "read_first">;

/**
 * The notes a writer's brief gets: at most three that name a path of the task, then core conventions, the more
 * useful first. Confirmed rules are left out (the rules block carries them). The caller records the mix once the
 * brief is final (`recordMemoryMixed`), so a mix that never reached a writer is not counted.
 */
export function mixWriterMemory(db: LanePilotDatabase, input: { projectId: string; query: string; task: TaskPaths; searchEngine: MemorySearchEngine; personalBot: string; ruleMemoryIds: ReadonlySet<string>;
  /** The run's sections: notes of a sibling section of a shared project are not this writer's. */
  chain?: readonly string[] }): { text: string; ids: string[] } {
  const found = searchMemoryRecords(db, input.projectId, input.query, 100, input.searchEngine, "subagent", input.personalBot, input.chain ? { chain: input.chain } : {}).filter((record) => !input.ruleMemoryIds.has(record.id));
  return { text: writerMemory(found, input.task), ids: writerMemoryPicks(found, input.task).map((record) => record.id) };
}

type ReviewTask = TaskPaths & Partial<Pick<TaskV2, "title" | "objective" | "acceptance">>;

/**
 * The notes a reviewer or critic gets (role `reviewer`): up to five, within the token budget, chosen for review rather
 * than for writing (`reviewerMemoryPicks`). Not counted as uses of a brief: the usefulness counters follow writers.
 */
export function mixReviewerMemory(db: LanePilotDatabase, input: { projectId: string; task: ReviewTask; searchEngine: MemorySearchEngine; personalBot: string; ruleMemoryIds: ReadonlySet<string>; budget: number; chain?: readonly string[] }): { text: string; ids: string[] } {
  const scoped = input.chain ? { chain: input.chain } : {};
  const query = [input.task.title, input.task.objective, ...(input.task.acceptance ?? []), ...input.task.owns_paths, ...input.task.read_first].filter(Boolean).join("\n");
  const found = searchMemoryRecords(db, input.projectId, query, 100, input.searchEngine, "subagent", input.personalBot, scoped).filter((record) => !input.ruleMemoryIds.has(record.id));
  // Not only what the task's words find: the review-tagged notes and the core conventions a reviewer judges against.
  const always = [...listMemory(db, input.projectId, { concepts: REVIEWER_CONCEPTS }, 20, "subagent", input.personalBot, scoped), ...listMemory(db, input.projectId, { kind: "core" }, 20, "subagent", input.personalBot, scoped)]
    .filter((record) => !input.ruleMemoryIds.has(record.id));
  const lines: string[] = [], ids: string[] = [];
  let used = 0;
  for (const note of reviewerMemoryPicks(found, always, input.task)) {
    const line = memoryLine(note);
    const size = estimateTokens(line);
    if (used + size > input.budget) continue;
    used += size; lines.push(line); ids.push(note.id);
  }
  return { text: lines.join("\n"), ids };
}

/** The reviewer's notes for a task of a run (settings of the run's sections); empty when the project's memory is off or not injected. */
export function reviewerMemoryFor(db: LanePilotDatabase, projectId: string, runId: string | null, task: ReviewTask): string {
  try {
    const settings = loadProjectSettings(db, projectId, runId ? getRunSettingsScopes(db, runId) : undefined);
    const memory = parseMemorySettings(Object.fromEntries(MEMORY_SETTING_KEYS.map((key) => [key, configuredSetting(settings, key)])));
    if (!memory.enabled || !memory.inject) return "";
    return mixReviewerMemory(db, { projectId, task, searchEngine: memory.searchEngine, personalBot: memory.personalBot, ruleMemoryIds: new Set(), budget: memory.contextBudget,
      ...(runId ? { chain: getRunSettingsScopes(db, runId) } : {}) }).text;
  } catch {
    return "";
  }
}

/** The project's notes ranked for a task text, the way the PM tool `context` action ranks them; empty when the project's memory is off. For a scheduled agent's first message. */
export function taskMemoryContext(db: LanePilotDatabase, projectId: string, runId: string | null, query: string): string {
  try {
    const chain = runId ? getRunSettingsScopes(db, runId) : undefined;
    const settings = loadProjectSettings(db, projectId, chain);
    const memory = parseMemorySettings(Object.fromEntries(MEMORY_SETTING_KEYS.map((key) => [key, configuredSetting(settings, key)])));
    return memory.enabled ? pmMemoryContext(db, projectId, memory, query, chain).text : "";
  } catch {
    return "";
  }
}

/** What the PM tool `lane_pilot_memory {action:"context"}` returns for a query: the project's records ranked for it, within the context budget. Also what the memory probe reads. */
export function pmMemoryContext(db: LanePilotDatabase, projectId: string, memory: MemorySettings, query: string, chain?: readonly string[]) {
  const records = searchMemoryRecords(db, projectId, query, 100, memory.searchEngine, memory.audience, memory.personalBot, chain ? { chain } : {});
  return memoryContext(records, query, memory.contextBudget);
}
