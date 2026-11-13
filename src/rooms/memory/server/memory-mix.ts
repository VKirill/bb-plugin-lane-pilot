import { DEFAULT_RELEVANCE_FLOOR, MEMORY_SETTING_KEYS, projectUsesSections, DENSE_PREFILTER, relevantRecords, resolveProjectKind, REVIEWER_CONCEPTS, activeMemoryDigestRows, estimateTokens, filesDrifted, listMemory, memoryContext, parseMemorySettings, pathsNamed, recordCriticUse, roleContextBudget, searchMemoryRecords, type MemoryRecord, type MemorySearchEngine, type MemorySettings, type RelevanceFloor } from "@lane-pilot/memory-core";
import type { TaskV2 } from "../../contracts";
import { getRunSettingsScopes, loadProjectSettings, projectHasScopedRun, type LanePilotDatabase } from "../../storage";
import { memoryLine, pathAnchors, reviewerMemoryPicks, writerMemory, writerMemoryPicks } from "./memory-picks";
import { configuredSetting } from "../../contracts/server";
import { judgeFound } from "./memory-judge";

type TaskPaths = Pick<TaskV2, "owns_paths" | "read_first">;

/**
 * The notes a writer's brief gets: at most three that name a path of the task, then core conventions, the more
 * useful first. Confirmed rules are left out (the rules block carries them). The caller records the mix once the
 * brief is final (`recordMemoryMixed`), so a mix that never reached a writer is not counted.
 */
type WriterMixInput = { projectId: string; query: string; task: TaskPaths & Partial<Pick<TaskV2, "kind" | "area" | "skills">>; searchEngine: MemorySearchEngine; personalBot: string; ruleMemoryIds: ReadonlySet<string>; now?: number; kind?: "auto"|"standalone"|"umbrella";
  /** memory.tag_notes: notes carrying a tag of the task (kind, area words, skills, path folders) join the brief. */
  tagNotes?: boolean; // unset reads as on
  /** The run's sections: notes of a sibling section of a shared project are not this writer's. */
  chain?: readonly string[];
  /** Current bytes of a repo-relative path. A note whose stored file hash no longer matches is left out of the brief. */
  readFile?: (path: string) => Uint8Array | null;
  /** The notes the judge let through (`judgeWriterMemory`); a search hit outside it is dropped. Unset: every hit stays. */
  allowedIds?: ReadonlySet<string> | null };

const umbrellaFor = (db: LanePilotDatabase, input: { projectId: string; kind?: "auto"|"standalone"|"umbrella" }) => resolveProjectKind(input.kind, projectUsesSections(db, input.projectId, projectHasScopedRun)) === "umbrella";
export function writerCandidates(db: LanePilotDatabase, input: WriterMixInput): MemoryRecord[] {
  return searchMemoryRecords(db, input.projectId, input.query, 100, input.searchEngine, "subagent", input.personalBot, { chain: input.chain ?? [], umbrella: umbrellaFor(db, input), ...(input.now !== undefined ? { now: input.now } : {}) }).filter((record) => !input.ruleMemoryIds.has(record.id));
}

/** Paths the writer's candidate notes name, so a caller can read them before `mixWriterMemory` drops the ones that drifted. */
export function writerMemoryPaths(db: LanePilotDatabase, input: WriterMixInput): string[] {
  return [...new Set([...writerCandidates(db, input), ...taggedCandidates(db, input).notes].flatMap((record) => pathsNamed(record.content)))];
}

/** Reads each path once. A path the reader throws on is missing. */
export async function snapshotFileRead(paths: readonly string[], readBytes: (path: string) => Promise<Uint8Array | null>): Promise<(path: string) => Uint8Array | null> {
  const cache = new Map<string, Uint8Array | null>();
  for (const path of [...new Set(paths)]) // an unreadable file just drops out of the mix
    cache.set(path, await readBytes(path).catch(() => null));
  return (path) => cache.get(path) ?? null;
}

/** The tags of a task, kept only where the project's tag cloud knows them: kind, skills, area words and the folders its paths name. */
export function taskMemoryTags(task: TaskPaths & Partial<Pick<TaskV2, "kind" | "area" | "skills">>, cloud: ReadonlySet<string>): string[] {
  const candidates = new Set<string>([
    ...(task.kind ? [task.kind] : []),
    ...(task.skills ?? []).flatMap((skill) => skill.toLowerCase().split(/[\s/,-]+/)),
    ...(task.area ?? "").toLowerCase().split(/[\s/,-]+/),
    ...pathAnchors(task).flatMap((anchor) => anchor.split("/")),
  ]);
  return [...candidates].filter((word) => word.length >= 3 && cloud.has(word));
}

/**
 * Notes carrying a tag of the task (memory.tag_notes, on when unset). No tag of the task in the project's cloud means no
 * notes: an empty concept list is no filter and would list the whole shelf. Core records stay out of this path: they are
 * conventions and rule texts, and a rule of another section is not this writer's.
 */
function taggedCandidates(db: LanePilotDatabase, input: WriterMixInput): { notes: MemoryRecord[]; tags: string[] } {
  if (input.tagNotes === false) return { notes: [], tags: [] };
  const tags = taskMemoryTags(input.task, new Set(activeMemoryDigestRows(db, input.projectId).flatMap((row) => JSON.parse(row.concepts_json || "[]") as string[])));
  if (!tags.length) return { notes: [], tags };
  const scoped = { chain: input.chain ?? [], umbrella: umbrellaFor(db, input), ...(input.now !== undefined ? { now: input.now } : {}) };
  return { tags, notes: listMemory(db, input.projectId, { concepts: tags }, 20, "subagent", input.personalBot, scoped)
    .filter((record) => record.kind !== "core" && !input.ruleMemoryIds.has(record.id)) };
}

/**
 * The writer's brief asks the judge once (the cache holds the answer for ten minutes, so a second brief of the same task does not ask again):
 * the search hits that name a path of the task stay, the others go to the judge, which keeps the ones that help. The ids that may reach
 * `mixWriterMemory`, or null when no judge ran (off, no hits): then the brief is what it was.
 */
export async function judgeWriterMemory(db: LanePilotDatabase, input: WriterMixInput, memory: MemorySettings): Promise<ReadonlySet<string> | null> {
  const found = writerCandidates(db, input);
  const anchors = pathAnchors(input.task);
  const named = found.filter((record) => anchors.some((anchor) => record.content.includes(anchor)));
  const rest = found.filter((record) => !named.includes(record) && (record.similarity === undefined || record.similarity >= DENSE_PREFILTER));
  const judged = await judgeFound(db, { projectId: input.projectId, query: input.query, found: rest, memory, surface: "writer" });
  return judged.judged ? new Set([...named, ...judged.records].map((record) => record.id)) : null;
}

export function mixWriterMemory(db: LanePilotDatabase, input: WriterMixInput): { text: string; ids: string[] } {
  const found = writerCandidates(db, input).filter((record) => !input.allowedIds || input.allowedIds.has(record.id));
  const kept = input.readFile ? found.filter((record) => !filesDrifted(record.fileFingerprint, pathsNamed(record.content), input.readFile!)) : found;
  const { notes, tags: taskTags } = taggedCandidates(db, input);
  const tagged = notes.filter((record) => !kept.some((hit) => hit.id === record.id) && !(input.readFile && filesDrifted(record.fileFingerprint, pathsNamed(record.content), input.readFile)));
  const all = [...kept, ...tagged];
  const tags = taskTags.filter((tag) => tagged.some((record) => record.concepts.includes(tag)));
  return { text: writerMemory(all, input.task, tags), ids: writerMemoryPicks(all, input.task, tags).map((record) => record.id) };
}

type ReviewTask = TaskPaths & Partial<Pick<TaskV2, "title" | "objective" | "acceptance">>;

/**
 * The notes a reviewer or critic gets (role `reviewer`): up to five, within the token budget, chosen for review rather
 * than for writing (`reviewerMemoryPicks`). Not counted as uses of a brief: the usefulness counters follow writers.
 */
export function mixReviewerMemory(db: LanePilotDatabase, input: { projectId: string; task: ReviewTask; searchEngine: MemorySearchEngine; personalBot: string; ruleMemoryIds: ReadonlySet<string>; budget: number; chain?: readonly string[]; now?: number; /** When the caller can read the workspace: a note whose file fingerprint drifted is kept but marked needs_review. */ readFile?: (path: string) => Uint8Array | null }): { text: string; ids: string[] } {
  const scoped = { chain: input.chain ?? [], umbrella: umbrellaFor(db, input), ...(input.now !== undefined ? { now: input.now } : {}) };
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

/** The PM path's search and its records after the relevance floor (the cosine pre-filter, a path named in the question, or enough rare words), before packing. */
function pmSearch(db: LanePilotDatabase, projectId: string, memory: MemorySettings, query: string, chain: readonly string[] | undefined, floor: RelevanceFloor | null) {
  const records = searchMemoryRecords(db, projectId, query, 100, memory.searchEngine, memory.audience, memory.personalBot, { chain: chain ?? [] });
  return relevantRecords(db, projectId, query, records, { audience: memory.audience, personalBot: memory.personalBot, floor });
}

/** The PM path's ranked records after the relevance floor, before packing. */
export function pmShortlist(db: LanePilotDatabase, projectId: string, memory: MemorySettings, query: string, chain?: readonly string[], floor: RelevanceFloor | null = memory.queryFloor === false ? null : DEFAULT_RELEVANCE_FLOOR): MemoryRecord[] {
  return pmSearch(db, projectId, memory, query, chain, floor);
}

/**
 * The PM's automatic per-turn context and the helpers': the vector's best notes without a judge (the judge costs seconds, and the PM reads
 * a list well alone), packed by the role's budget. No warning line: a search the notes cannot answer shows the empty-list «nothing».
 */
export function pmMemoryContext(db: LanePilotDatabase, projectId: string, memory: MemorySettings, query: string, chain?: readonly string[], role = "pm", floor: RelevanceFloor | null = memory.queryFloor === false ? null : DEFAULT_RELEVANCE_FLOOR) {
  const packed = memoryContext(pmSearch(db, projectId, memory, query, chain, floor), query, roleContextBudget(role, memory.contextBudget));
  return { ...packed, nothingRelevant: packed.records.length === 0 };
}

/** What the PM tool `lane_pilot_memory {action:"context"}` returns for a query (an explicit search): the same search, then the judge, then the packing. */
export async function pmMemoryContextJudged(db: LanePilotDatabase, projectId: string, memory: MemorySettings, query: string, chain?: readonly string[], role = "pm", floor: RelevanceFloor | null = memory.queryFloor === false ? null : DEFAULT_RELEVANCE_FLOOR) {
  const judged = await judgeFound(db, { projectId, query, found: pmSearch(db, projectId, memory, query, chain, floor), memory, surface: "pm_tool", audience: memory.audience });
  const packed = memoryContext(judged.records, query, roleContextBudget(role, memory.contextBudget));
  return { ...packed, nothingRelevant: packed.records.length === 0 };
}
