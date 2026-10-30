import { DEFAULT_RELEVANCE_FLOOR, MEMORY_SETTING_KEYS, relevantRecords, REVIEWER_CONCEPTS, estimateTokens, filesDrifted, listMemory, memoryContext, parseMemorySettings, pathsNamed, recordCriticUse, roleContextBudget, searchMemoryRecords, type MemoryRecord, type MemorySearchEngine, type MemorySettings, type RelevanceFloor } from "@lane-pilot/memory-core";
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
type WriterMixInput = { projectId: string; query: string; task: TaskPaths; searchEngine: MemorySearchEngine; personalBot: string; ruleMemoryIds: ReadonlySet<string>; now?: number;
  /** The run's sections: notes of a sibling section of a shared project are not this writer's. */
  chain?: readonly string[];
  /** Current bytes of a repo-relative path. A note whose stored file hash no longer matches is left out of the brief. */
  readFile?: (path: string) => Uint8Array | null };

export function writerCandidates(db: LanePilotDatabase, input: WriterMixInput): MemoryRecord[] {
  return searchMemoryRecords(db, input.projectId, input.query, 100, input.searchEngine, "subagent", input.personalBot, { chain: input.chain ?? [], ...(input.now !== undefined ? { now: input.now } : {}) }).filter((record) => !input.ruleMemoryIds.has(record.id));
}

/** Paths the writer's candidate notes name, so a caller can read them before `mixWriterMemory` drops the ones that drifted. */
export function writerMemoryPaths(db: LanePilotDatabase, input: WriterMixInput): string[] {
  return [...new Set(writerCandidates(db, input).flatMap((record) => pathsNamed(record.content)))];
}

/** Reads each path once. A path the reader throws on is missing. */
export async function snapshotFileRead(paths: readonly string[], readBytes: (path: string) => Promise<Uint8Array | null>): Promise<(path: string) => Uint8Array | null> {
  const cache = new Map<string, Uint8Array | null>();
  for (const path of [...new Set(paths)]) cache.set(path, await readBytes(path).catch(() => null));
  return (path) => cache.get(path) ?? null;
}

export function mixWriterMemory(db: LanePilotDatabase, input: WriterMixInput): { text: string; ids: string[] } {
  const found = writerCandidates(db, input);
  const kept = input.readFile ? found.filter((record) => !filesDrifted(record.fileFingerprint, pathsNamed(record.content), input.readFile!)) : found;
  return { text: writerMemory(kept, input.task), ids: writerMemoryPicks(kept, input.task).map((record) => record.id) };
}

type ReviewTask = TaskPaths & Partial<Pick<TaskV2, "title" | "objective" | "acceptance">>;

/**
 * The notes a reviewer or critic gets (role `reviewer`): up to five, within the token budget, chosen for review rather
 * than for writing (`reviewerMemoryPicks`). Not counted as uses of a brief: the usefulness counters follow writers.
 */
export function mixReviewerMemory(db: LanePilotDatabase, input: { projectId: string; task: ReviewTask; searchEngine: MemorySearchEngine; personalBot: string; ruleMemoryIds: ReadonlySet<string>; budget: number; chain?: readonly string[]; now?: number; /** When the caller can read the workspace: a note whose file fingerprint drifted is kept but marked needs_review. */ readFile?: (path: string) => Uint8Array | null }): { text: string; ids: string[] } {
  const scoped = { chain: input.chain ?? [], ...(input.now !== undefined ? { now: input.now } : {}) };
  const query = [input.task.title, input.task.objective, ...(input.task.acceptance ?? []), ...input.task.owns_paths, ...input.task.read_first].filter(Boolean).join("\n");
  const found = searchMemoryRecords(db, input.projectId, query, 100, input.searchEngine, "subagent", input.personalBot, scoped).filter((record) => !input.ruleMemoryIds.has(record.id));
  // Not only what the task's words find: the review-tagged notes and the core conventions a reviewer judges against.
  const always = [...listMemory(db, input.projectId, { concepts: REVIEWER_CONCEPTS }, 20, "subagent", input.personalBot, scoped), ...listMemory(db, input.projectId, { kind: "core" }, 20, "subagent", input.personalBot, scoped)]
    .filter((record) => !input.ruleMemoryIds.has(record.id));
  const lines: string[] = [], ids: string[] = [];
  let used = 0;
  for (const note of reviewerMemoryPicks(found, always, input.task)) {
    // A reviewer may still need the note — it is marked, not skipped (a writer's mix drops these instead).
    const stale = input.readFile && filesDrifted(note.fileFingerprint, pathsNamed(note.content), input.readFile);
    const line = `${stale ? "[needs_review] " : ""}${memoryLine(note)}`;
    const size = estimateTokens(line);
    if (used + size > input.budget) continue;
    used += size; lines.push(line); ids.push(note.id);
  }
  recordCriticUse(db, input.projectId, ids);
  return { text: lines.join("\n"), ids };
}

/** The reviewer's notes for a task of a run (settings of the run's sections); empty when the project's memory is off or not injected. */
export function reviewerMemoryFor(db: LanePilotDatabase, projectId: string, runId: string | null, task: ReviewTask): string {
  try {
    const settings = loadProjectSettings(db, projectId, runId ? getRunSettingsScopes(db, runId) : undefined);
    const memory = parseMemorySettings(Object.fromEntries(MEMORY_SETTING_KEYS.map((key) => [key, configuredSetting(settings, key)])));
    if (!memory.enabled || !memory.inject) return "";
    return mixReviewerMemory(db, { projectId, task, searchEngine: memory.searchEngine, personalBot: memory.personalBot, ruleMemoryIds: new Set(), budget: roleContextBudget("critic",memory.contextBudget),
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
    // A scheduled agent is a helper: its share of the context budget is the helper's, not the PM's.
    return memory.enabled ? pmMemoryContext(db, projectId, memory, query, chain, "helper").text : "";
  } catch {
    return "";
  }
}

/** What the PM tool `lane_pilot_memory {action:"context"}` returns for a query: the project's records ranked for it, within the context budget. Also what the memory probe reads. */
export function pmMemoryContext(db: LanePilotDatabase, projectId: string, memory: MemorySettings, query: string, chain?: readonly string[], role = "pm", floor: RelevanceFloor | null = memory.queryFloor === false ? null : DEFAULT_RELEVANCE_FLOOR) {
  const records = searchMemoryRecords(db, projectId, query, 100, memory.searchEngine, memory.audience, memory.personalBot, { chain: chain ?? [] });
  // The relevance floor (a query path only): a question the notes cannot answer gets an explicit «nothing». `floor: null` is the old behaviour.
  const packed = memoryContext(relevantRecords(db, projectId, query, records, { audience: memory.audience, personalBot: memory.personalBot, floor }), query, roleContextBudget(role,memory.contextBudget));
  return { ...packed, nothingRelevant: packed.records.length === 0 };
}
