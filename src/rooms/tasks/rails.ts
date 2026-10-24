/**
 * The task graph's rails at the level of one task (SMA map: Task graph — Task birth and words, Durable queue row, Life of one attempt).
 * Pure decisions; the contract lint, the dispatch and the writer's finish call them.
 */

/** Where a task row was born (SMA: Five birth kinds of a row); recorded on the task, the board and the metrics read it. */
export const BIRTH_KINDS = ["pm", "workflow", "backlog", "phase", "redo", "bench"] as const;
export type BirthKind = (typeof BIRTH_KINDS)[number];

/** Queue priority (SMA: Queue priority, Urgency into queue position): a higher one starts first when the run waits for a free writer. */
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const priorityRank = (priority: string | undefined) => {
  const index = PRIORITIES.indexOf((priority ?? "normal") as Priority);
  return index < 0 ? 1 : index;
};

/** Orders queued tasks for a free writer: priority first (urgent before low), then the order they were queued in. */
export function queueOrder<T extends { priority?: string; queuedAt: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.queuedAt - b.queuedAt);
}

/** The three classes a task that cannot start falls into (SMA: Three blocking classes): something is missing, something must come first, or something is in the way. */
export type BlockingClass = "missing_info" | "dependency" | "conflict";
export function blockingClass(code: string): BlockingClass | null {
  if (/^(clarify_open|read_first_missing|read_first_path|secret_missing|secret_name_unknown|secret_catalog_unavailable|task_standard_|promise_missing|check_not_runnable|missing_)/.test(code)) return "missing_info";
  if (/^(depends_dead|depends_|waiting_secret|held)/.test(code)) return "dependency";
  if (/^(owns_overlap|ownership_|never_touch|area_busy|conflict|verification_cwd|task_in_progress)/.test(code)) return "conflict";
  return null;
}

type Contract = {
  risk?: string; kind?: string; owns_paths?: readonly string[]; verification?: ReadonlyArray<{ command: string }>;
  promise?: { given?: string; when?: string; then?: string }; clarify?: { questions?: readonly string[] }; drawing?: readonly string[];
};

const UI_PATH = /\.(tsx|jsx|vue|svelte|css|scss|html)$|(^|\/)(ui|components|pages|screens|views)\//i;
const atLeastMedium = (risk: string | undefined) => risk === "medium" || risk === "high" || risk === "critical";

/** Findings of the task-birth rails; errors stop the dispatch, warnings go back with it. */
export function birthFindings(task: Contract): { errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> } {
  const errors: Array<{ code: string; message: string }> = [];
  const warnings: Array<{ code: string; message: string }> = [];
  // Clarification awaits: open questions stop the task until they are answered (the PM removes them with the answer in the words).
  const questions = task.clarify?.questions?.filter((question) => question.trim()) ?? [];
  if (questions.length) errors.push({ code: "clarify_open", message: `the task has open clarification questions: ${questions.join("; ")} — answer them (ask the owner if only he knows), fold the answers into the contract and drop clarify, then send it again` });
  // Promise: Given, When, Then — a feature or fix of medium risk or more says what it promises in those words.
  const promise = task.promise;
  const writing = task.kind === undefined || task.kind === "feature" || task.kind === "fix";
  if (promise && !(promise.given?.trim() && promise.when?.trim() && promise.then?.trim())) errors.push({ code: "promise_incomplete", message: "promise needs given, when and then, each a short sentence" });
  else if (!promise && writing && atLeastMedium(task.risk)) warnings.push({ code: "promise_missing", message: "a feature or fix of medium risk or more states its promise: promise {given, when, then} — the checks then prove that sentence" });
  // Is a drawing needed: a standalone task that changes screens at medium risk or more names its drawing (or goes through a phase, which draws).
  const ui = (task.owns_paths ?? []).some((path) => UI_PATH.test(path));
  if (ui && atLeastMedium(task.risk) && !(task.drawing?.length)) warnings.push({ code: "drawing_needed", message: "the task changes screens at medium risk or more: name the drawing it follows (drawing: [paths]) or open a phase (lane_pilot_phase), whose design stage draws and reviews it" });
  return { errors, warnings };
}

/** The program a check runs first, for «is the check command runnable»: env assignments, sudo and the like skipped; null for shell syntax. */
export function checkProgram(command: string): string | null {
  const words = command.trim().split(/\s+/);
  let index = 0;
  while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!) || ["env", "sudo", "nice", "time", "timeout", "command"].includes(words[index]!))) {
    if (words[index] === "timeout") index += 1;
    index += 1;
  }
  const program = words[index];
  if (!program || /^[(&|;!{]/.test(program) || program.includes("$")) return null;
  return program.replace(/^["']|["']$/g, "");
}

/** Approach and lesson markers the writer's final report carries (SMA: Approach and lesson markers, Lesson or a reason for none). */
export type WriterMarkers = { approach: string | null; lesson: string | null; noLessonReason: string | null };
export function writerMarkers(report: string): WriterMarkers {
  const line = (label: string) => report.match(new RegExp(`^\\s*(?:[-*]\\s*)?\\**${label}\\**\\s*[:：]\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;
  const lesson = line("LESSON");
  const none = lesson && /^none\b|^нет\b/i.test(lesson) ? lesson.replace(/^(none|нет)\s*[—:-]?\s*/i, "").trim() || "no reason given" : null;
  return { approach: line("APPROACH"), lesson: none ? null : lesson, noLessonReason: none };
}

/** The marker lines the writer's brief asks for. */
export const MARKER_BRIEF_LINE = "End your final report with two lines: `APPROACH: <how you solved it, one sentence>` and `LESSON: <what the next writer should know>` (or `LESSON: none — <why there is nothing to learn>`).";

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

/**
 * Reference-test edit trace (SMA: Reference-test edit trace, Unauthorised reference edit): tests that existed before the attempt and
 * that the attempt modified or deleted. A writer that edits the tests it is judged by is flagged for the critic and the acceptance card.
 */
export function referenceTestEdits(changes: ReadonlyArray<{ path: string; status: string }>): string[] {
  return changes.filter((change) => TEST_PATH.test(change.path) && /^(M|D|R)/.test(change.status)).map((change) => change.path);
}

/** Spend reserve (SMA: Spend reserve): a task may start only when the run's budget still holds its appetite after the open tasks' appetites. */
export function spendReserve(input: { budgetTokens: number | null; spentTokens: number; openAppetites: readonly number[]; appetite: number | null }): { ok: boolean; free: number | null; why?: string } {
  if (input.budgetTokens === null) return { ok: true, free: null };
  const reserved = input.openAppetites.reduce((sum, value) => sum + value, 0);
  const free = input.budgetTokens - input.spentTokens - reserved;
  if (input.appetite !== null && input.appetite > free) return { ok: false, free, why: `the run's budget keeps ${Math.max(0, free)} tokens after the open tasks' appetites; this task's appetite is ${input.appetite}` };
  return { ok: true, free };
}

/** Dead letters (SMA: Dead-letter queue): tasks whose latest attempt ended blocked or spawn_rejected and nobody sent again within a day. */
export function deadLetters<T extends { state: string; updatedAt: number }>(rows: readonly T[], now: number, graceMs = 86_400_000): T[] {
  return rows.filter((row) => (row.state === "blocked" || row.state === "spawn_rejected") && now - row.updatedAt >= graceMs);
}

/** A hold (SMA: Held until year 2999): a task kept out of the queue until a person or the PM releases it; the year 2999 marks «no date». */
export const HOLD_FOREVER = Date.UTC(2999, 0, 1);

/** Four lane queues (SMA: Four lane queues): the kind of work decides which queue a task waits in; each queue can have its own cap (setting queue.lane_caps). */
export const LANE_QUEUES = ["write", "check", "docs", "research"] as const;
export type LaneQueue = (typeof LANE_QUEUES)[number];
export function laneQueueOf(kind: string | undefined): LaneQueue {
  if (kind === "check") return "check";
  if (kind === "docs") return "docs";
  if (kind === "research") return "research";
  return "write";
}
/** The cap of a lane queue from the setting (`{"check": 2, "research": 1}`); null when that lane has none. */
export function laneCap(setting: unknown, lane: LaneQueue): number | null {
  let value: unknown = setting;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
  const cap = value && typeof value === "object" ? (value as Record<string, unknown>)[lane] : undefined;
  return typeof cap === "number" && Number.isInteger(cap) && cap >= 1 && cap <= 50 ? cap : null;
}
