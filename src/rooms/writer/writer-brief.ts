import { REVIEWER_CONCEPTS, memoryUsefulness, sameSubject } from "@lane-pilot/memory-core";
import type { TaskV2 } from "../contracts";

/**
 * The writer's brief, kept small. Measured on SelfyStudio `gc-pages-polish-2` (2026-10-03): 64% of the old prompt
 * was memory — 16 notes, one of them about the task, seven raw «attempt failed: outside owns_paths» episodes — and
 * the same writer did the task as well from 1110 tokens as from 4130. Live run notes: `.bb/chats/thr_tev4nistgf/artifacts/tz-diet/REPORT.md`.
 */

type MemoryNote = { content:string; concepts:string[]; kind?:string; id?:string; useCount?:number; acceptedCount?:number; createdAt?:number };

const MEMORY_LIMIT = 3;
/** Folders that say nothing about a task: tool caches a contract sometimes lists. */
const CACHE_SEGMENTS = new Set([".vite", ".turbo", ".cache", ".next", ".nuxt", "node_modules", "dist", "coverage"]);

/**
 * The last two folder segments of each owned or read path (`components/greeting-cards`, `src/site-tool-card-page`).
 * A note is about the task when it names one of them; single words matched notes about other parts of the product.
 */
export function pathAnchors(task:Pick<TaskV2, "owns_paths" | "read_first">):string[] {
  const anchors = new Set<string>();
  for (const path of [...task.owns_paths, ...task.read_first]) {
    let segments = path.split(/[*?[]/)[0]!.split("/").filter(Boolean);
    if (segments.some((segment) => CACHE_SEGMENTS.has(segment))) continue;
    if (segments.length && /\.[A-Za-z0-9]+$/.test(segments.at(-1)!)) segments = segments.slice(0, -1);
    if (segments.length >= 2) anchors.add(segments.slice(-2).join("/"));
  }
  return [...anchors];
}

/**
 * At most three notes: those that name a path of this task, then the project's core conventions, without their
 * tags. Raw failure episodes stay out: what repeats becomes a rule through the rules pipeline, and the brief
 * carries the rule instead.
 */
export function writerMemory(notes:readonly MemoryNote[], task:Pick<TaskV2, "owns_paths" | "read_first">):string {
  // One line per note: a note with line breaks could forge the next heading of the brief.
  return writerMemoryPicks(notes, task).map(memoryLine).join("\n");
}

/** One bullet per note, on one line, without the wrapper tags of the block it goes into: a note cannot close the block or forge a heading. */
export function memoryLine(note:Pick<MemoryNote, "content">):string {
  return `- ${note.content.replace(/<\/?project_memory>/gi, "").replace(/\s+/g, " ").trim()}`;
}

const REVIEW_LIMIT = 5;
/** A core convention this young goes before the proven ones: by usefulness alone a new one never reached a reviewer (it gains use only by being there). */
const FRESH_CORE_MS = 3 * 86_400_000;

/**
 * The notes a reviewer or critic gets, at most five: review-tagged notes about the task's paths, then other notes about
 * its paths, the project's core conventions (a reviewer judges against them; review-tagged notes the task's words merely
 * found pushed them out), then those found notes, and last the remaining review-tagged notes. `found` is the search for
 * the task's text, `always` the review-tagged notes and core conventions whatever the text; rules never go in.
 */
export function reviewerMemoryPicks<T extends MemoryNote>(found:readonly T[], always:readonly T[], task:Pick<TaskV2, "owns_paths" | "read_first">, limit = REVIEW_LIMIT, now = Date.now()):T[] {
  const anchors = pathAnchors(task);
  const keyOf = (note:T) => note.id ?? note.content;
  const foundKeys = new Set(found.map(keyOf));
  const merged = new Map<string, T>();
  for (const note of [...found, ...always]) if (!merged.has(keyOf(note))) merged.set(keyOf(note), note);
  const usable = [...merged.values()].filter((note) => !note.concepts.includes("lesson") && !note.concepts.includes("rule"));
  const isTagged = (note:T) => note.concepts.some((concept) => (REVIEWER_CONCEPTS as readonly string[]).includes(concept));
  const about = (note:T) => anchors.some((anchor) => note.content.includes(anchor));
  const byUse = (a:T, b:T) => memoryUsefulness(b) - memoryUsefulness(a);
  const fresh = (note:T) => note.kind === "core" && typeof note.createdAt === "number" && now - note.createdAt < FRESH_CORE_MS;
  // The core tier: the conventions added in the last days first (newest first), then the proven ones by usefulness.
  const coreOrder = (a:T, b:T) => (fresh(a) === fresh(b) ? (fresh(a) ? (b.createdAt ?? 0) - (a.createdAt ?? 0) : byUse(a, b)) : fresh(a) ? -1 : 1);
  const tiers:T[][] = [
    usable.filter((note) => isTagged(note) && about(note)),
    usable.filter((note) => !isTagged(note) && about(note)),
    usable.filter((note) => !isTagged(note) && !about(note) && note.kind === "core"),
    usable.filter((note) => isTagged(note) && !about(note) && foundKeys.has(keyOf(note))),
    usable.filter((note) => isTagged(note) && !about(note) && !foundKeys.has(keyOf(note))),
  ].map((tier, index) => tier.sort(index === 2 ? coreOrder : byUse));
  return tiers.flat().slice(0, limit);
}

/**
 * The notes `writerMemory` writes out; within each group they keep the order the search gave them, best match first. Not reordered by
 * how often a note was in an accepted brief: with a median of 10 notes naming a task's folders, that counter put the notes that had
 * been picked before ahead of the best match and cut the hit rate on the real hub shelf from 63% to 41% (`bb lane-pilot memory-eval`,
 * docs/memory.md). The counters still rank the PM context and the reviewers' tiers.
 */
export function writerMemoryPicks<T extends MemoryNote>(notes:readonly T[], task:Pick<TaskV2, "owns_paths" | "read_first">):T[] {
  const anchors = pathAnchors(task);
  const usable = notes.filter((note) => !note.concepts.includes("lesson"));
  const aboutPaths = usable.filter((note) => anchors.some((anchor) => note.content.includes(anchor)));
  const core = usable.filter((note) => note.kind === "core" && !aboutPaths.includes(note));
  const picked: T[] = [];
  // A near-duplicate would spend one of the three slots on the same fact (arxiv slate). Search order stays; usefulness does not reorder.
  for (const note of [...aboutPaths, ...core]) {
    if (picked.some((kept) => sameSubject(kept, note))) continue;
    picked.push(note);
    if (picked.length === MEMORY_LIMIT) break;
  }
  return picked;
}

/** The PM read stage's key facts for the writer; its overview repeats the task and its open questions are the PM's. */
export function pmReadBrief(pmReadContext:string):{ facts:string; openQuestions:string[] } {
  try {
    const parsed = JSON.parse(pmReadContext) as { keyFacts?:unknown; openQuestions?:unknown };
    const facts = Array.isArray(parsed.keyFacts) ? parsed.keyFacts.filter((fact):fact is string => typeof fact === "string") : null;
    const openQuestions = Array.isArray(parsed.openQuestions) ? parsed.openQuestions.filter((item):item is string => typeof item === "string") : [];
    if (facts) return { facts:facts.map((fact) => `- ${fact}`).join("\n"), openQuestions };
  } catch { /* plain text summary */ }
  return { facts:pmReadContext.trim(), openQuestions:[] };
}

/** The contract once: no empty fields, no defaults, the workspace and the read list only where the brief has them. */
export function compactContract(task:TaskV2, readListShown:boolean):Record<string, unknown> {
  const out:Record<string, unknown> = {};
  for (const [key, value] of Object.entries(task)) {
    // The PM's forecast is measured against what the writer does: the writer does not see it.
    if (key === "schema_version" || key === "project_cwd" || key === "forecast" || (key === "read_first" && readListShown)) continue;
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
    if (key === "verification" && Array.isArray(value)) {
      out[key] = value.map((command) => {
        const row = command as { command?:string; cwd?:string; timeout_sec?:number; secrets?:string[] };
        // Names of the secrets a check gets stay visible (never their values); the rest collapses to the command.
        if (row.secrets?.length) return row.cwd && row.cwd !== task.project_cwd ? row : { command:row.command, secrets:row.secrets };
        return row.cwd && row.cwd !== task.project_cwd ? row : row.command;
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}

type StatsDb = { prepare(sql:string):{ all(...args:unknown[]):unknown[] } };

/**
 * How briefs and their outcomes compare over a period: brief size, tasks accepted on their first attempt, attempts
 * rejected for touching paths outside owns_paths. Run it for a period before and after a brief change.
 */
export function writerBriefStats(db:StatsDb, projectId:string, since:number, until:number) {
  const rows = db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.attempt_no, t.trace_json FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id LEFT JOIN lane_pilot_attempt_reasoning t ON t.attempt_id=a.id
    WHERE r.project_id=? AND a.created_at>=? AND a.created_at<? ORDER BY a.created_at`).all(projectId, since, until) as Array<{
      id:string; run_id:string; task_id:string; state:string; reason:string|null; attempt_no:number; trace_json:string|null }>;
  const contexts:number[] = [], prompts:number[] = [];
  for (const row of rows) {
    let trace:{ dispatchContext?:{ memoryText?:string; pmReadContext?:string; executionPacket?:string; rulesText?:string; promptChars?:number } } | null = null;
    try { trace = row.trace_json ? JSON.parse(row.trace_json) : null; } catch { trace = null; }
    const context = trace?.dispatchContext;
    if (!context) continue;
    contexts.push((context.memoryText ?? "").length + (context.pmReadContext ?? "").length + (context.executionPacket ?? "").length + (context.rulesText ?? "").length);
    if (typeof context.promptChars === "number") prompts.push(context.promptChars);
  }
  const tasks = new Map<string, typeof rows>();
  for (const row of rows) tasks.set(`${row.run_id}:${row.task_id}`, [...(tasks.get(`${row.run_id}:${row.task_id}`) ?? []), row]);
  const finished = [...tasks.values()].filter((attempts) => attempts.some((row) => ["accepted", "blocked", "canceled"].includes(row.state)));
  const firstTry = finished.filter((attempts) => attempts[0]!.state === "accepted").length;
  const outside = rows.filter((row) => /outside owns_paths|owns_paths rejected/.test(row.reason ?? "")).length;
  const mean = (values:number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  return {
    attempts:rows.length, finishedTasks:finished.length,
    firstAttemptAccepted:firstTry, firstAttemptAcceptedShare:finished.length ? Math.round(100 * firstTry / finished.length) : null,
    outsideOwnsPaths:outside, outsideOwnsPathsShare:rows.length ? Math.round(100 * outside / rows.length) : null,
    avgContextChars:mean(contexts), avgPromptChars:mean(prompts), briefsMeasured:prompts.length,
  };
}
