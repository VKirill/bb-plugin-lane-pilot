import type { LessonSource } from "./lessons";
import type { RepeatedLesson } from "./rule-schema";

export const clip = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The part of a failure that stays the same when it repeats: paths, numbers, hashes and command lines are masked. */
export function normalizeLessonText(text: string): string {
  return text.toLowerCase()
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<s>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<h>")
    .replace(/[^\s,;:()]*[/\\][^\s,;:()]*|[^\s,;:()]+\.[a-z0-9]{1,8}\b/g, "<p>")
    .replace(/\d+/g, "<n>")
    .replace(/<p>(?:\s*,\s*<p>)+/g, "<p>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function sourceText(source: LessonSource): string {
  if (source.kind === "night_finding") return source.finding;
  return source.reason;
}

/** One failure is often recorded by several stages of the same attempt; the signature leaves the stage out so they count once. */
export function lessonSignature(source: LessonSource): string {
  if (source.kind === "night_finding") return `night-review ${source.severity}: ${normalizeLessonText(source.finding)}`;
  return normalizeLessonText(source.reason);
}

/** Failures of the run machinery or of the PM's plan; a rule for writers cannot prevent them. */
const NOT_WRITER = /^(internal_error|attempt_worktree_|attempt_workspace_|execution_packet_failed|writer_provider_unavailable|writer_live_catalog|writer_model_unavailable|emergency_fallback_failed|spawn_|reconcile_|ownership run scope invalid|code_critique_helper|structural_plan_critique|critique_changes_requested|merge_conflict)/i;

/** Files Lane Pilot's hooks and sibling agents write on their own; a rejection naming only these is not the writer's. */
const BOOKKEEPING_PATH = /^(\.agents\/|\.bb\/|\.claude\/|PROGRESS\.md$)/;

export function isWriterLesson(source: LessonSource): boolean {
  if (source.kind === "night_finding") return true;
  if (source.kind === "rejection" && source.stage === "plan-critique") return false;
  const paths = /(?:owns_paths rejected |never_touch: )(.+)$/s.exec(source.reason)?.[1]?.split(",").map((path) => path.trim()).filter(Boolean) ?? [];
  if (paths.length > 0 && paths.every((path) => BOOKKEEPING_PATH.test(path))) return false;
  return !NOT_WRITER.test(source.reason.trim());
}

/**
 * Writer failures with the same signature in at least `minOccurrences` distinct run tasks across at least
 * `minTasks` task ids. A task counts once however many stages recorded the failure.
 */
export function repeatedLessons(sources: readonly LessonSource[], options: { minOccurrences?: number; minTasks?: number } = {}): RepeatedLesson[] {
  const minOccurrences = options.minOccurrences ?? 3;
  const minTasks = options.minTasks ?? 2;
  const groups = new Map<string, { sources: LessonSource[]; runTasks: Set<string>; tasks: Set<string> }>();
  for (const source of sources) {
    if (!isWriterLesson(source)) continue;
    const signature = lessonSignature(source);
    const group = groups.get(signature) ?? { sources: [], runTasks: new Set<string>(), tasks: new Set<string>() };
    const runTask = `${source.runId}/${source.taskId}`;
    if (group.runTasks.has(runTask)) continue;
    group.runTasks.add(runTask);
    group.tasks.add(source.taskId);
    group.sources.push(source);
    groups.set(signature, group);
  }
  const result: RepeatedLesson[] = [];
  for (const [signature, group] of groups) {
    if (group.sources.length < minOccurrences || group.tasks.size < minTasks) continue;
    const examples = [...new Set(group.sources.map((source) => clip(sourceText(source), 300)))].slice(0, 3);
    const times = group.sources.map((source) => source.at);
    result.push({ signature, occurrences: group.sources.length, taskCount: group.tasks.size, examples,
      firstSeenAt: Math.min(...times), lastSeenAt: Math.max(...times) });
  }
  return result.sort((a, b) => b.occurrences - a.occurrences || b.lastSeenAt - a.lastSeenAt);
}

/** A first wording for the owner or the PM to rewrite; it names the failure, not the fix. */
export function draftRule(lesson: RepeatedLesson): string {
  return `Repeated in ${lesson.occurrences} tasks: ${lesson.examples[0] ?? lesson.signature} — before finishing a task, make sure this does not happen.`;
}
