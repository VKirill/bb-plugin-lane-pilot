import { isAbsolute, relative } from "node:path";
import { fileAllowedByOwns, fileBlockedByNeverTouch, id } from "@lane-pilot/kit";
import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { getAttempt, getRun, getTask, getTaskPlan, listOpenAttempts, taskBasePath, updateTaskContract } from "../../storage";
import { checkoutOwnsOverlap } from "../../tasks";

import { getBaseline } from "../../baseline";
import { markPathsWidened } from "../../critique";
import { markTaskSatisfied } from "../../runs/server";
import { finishReturn, insertReturn, listReturns } from "../../stage-return";
import { classifyQuestion } from "./question-class";
import { contractFixTurnPrompt, createAttemptReopen } from "./reopen-attempt";
import { createWriterAnswer } from "./answer";
import type { WriterStateApi } from "./state";
import type { WriterStartApi } from "./start";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  startWriterTask: WriterStartApi["startWriterTask"];
}

/** The `by` of the stage_return row each automatic answer leaves: the rule is in the note (`rule:<name> ...`), so outcomes can be counted. */
export const QUESTION_RULES = "question-rules";
/** At most this many files are added to owns_paths on one question. */
export const MAX_WIDEN_FILES = 5;

export type RuleResult = { rule: string; ok: boolean; detail: string };

type Row = { id: string; run_id: string; task_id: string; project_id: string; thread_id: string | null };
type Doors = { answerWriter: (answer: string) => Promise<boolean>; cancel: (why: string) => Promise<void> };

/** A file as a path inside the task's checkout, or null when it is a glob, climbs out, or lies outside it. */
export function insidePath(file: string, base: string): string | null {
  let path = file.replace(/^\.\//, "");
  if (isAbsolute(path)) path = relative(base, path);
  if (!path || path.startsWith("..") || isAbsolute(path) || /[*?\[\]]/.test(path) || path.split("/").includes("..")) return null;
  return path.split("\\").join("/");
}

/**
 * The machine answers by rule what a person never needed to (hub, 30 days: 67 writer stops, 0 needed a person). Each rule acts through a
 * door that already exists (the PM's answer, a contract fix under the question, satisfied) on the same attempt, spends no attempt, and leaves
 * a stage_return row by `question-rules` naming the rule and what it changed. A rule that does not apply returns null and the question goes on to
 * the second pilot. One answer per rule per task.
 */
export function createQuestionRules(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  const reopen = createAttemptReopen(ctx, services);
  const { answerWriter } = createWriterAnswer(ctx, services);

  const ruleCount = (row: Row, rule: string) => listReturns(db, row.run_id, row.task_id).filter((record) => record.by === QUESTION_RULES && record.note.startsWith(`rule:${rule} `)).length;

  function record(row: Row, rule: string, question: string, ok: boolean, detail: string, now: number): RuleResult {
    const returnId = id("lpret");
    insertReturn(db, { id: returnId, at: now, projectId: row.project_id, runId: row.run_id, taskId: row.task_id, attemptId: row.id, to: "writer", from: "writer", by: QUESTION_RULES,
      note: `rule:${rule} ${ok ? "answered" : "failed"}: ${question.slice(0, 300)}`, reused: [], stale: [] });
    finishReturn(db, returnId, { state: ok ? "restarted" : "failed", detail: detail.slice(0, 1000) });
    ctx.log(`question rule ${rule} on ${row.task_id}: ${ok ? "answered" : "failed"}: ${detail.slice(0, 200)}`);
    return { rule, ok, detail };
  }

  /** The contract with `files` added to owns_paths under the limits (≤5, inside the checkout, not never_touch, not another live task's), or why not. */
  function widened(row: Row, task: TaskV2, files: readonly string[]): { files: string[] } | { why: string } {
    const base = taskBasePath(db, row.run_id, row.task_id) ?? task.project_cwd;
    const inside = files.map((file) => insidePath(file, base));
    if (!files.length || inside.some((path) => !path)) return { why: "a named file is a glob or lies outside the task's checkout" };
    const add = [...new Set(inside as string[])].filter((path) => !fileAllowedByOwns(path, task.owns_paths));
    if (!add.length) return { why: "every named file is already owned" };
    if (add.length > MAX_WIDEN_FILES) return { why: `${add.length} files, more than ${MAX_WIDEN_FILES}` };
    const never = add.find((path) => fileBlockedByNeverTouch(path, task.never_touch));
    if (never) return { why: `${never} is in never_touch` };
    for (const open of listOpenAttempts(db)) {
      if (open.project_id !== row.project_id || open.task_id === row.task_id) continue;
      const other = taskV2Schema.safeParse(getTask(db, open.task_id)?.contract);
      if (other.success && checkoutOwnsOverlap(base, add, taskBasePath(db, open.run_id, open.task_id), other.data.owns_paths)) return { why: `${add.join(", ")} overlaps ${open.task_id}, a live task` };
    }
    return { files: add };
  }

  /** Stores the fixed contract and reopens the same attempt with the change as its turn; puts the old contract back when the writer cannot take it. */
  async function fixContract(row: Row, old: TaskV2, next: TaskV2, question: string, summary: string): Promise<{ ok: true } | { ok: false; why: string }> {
    const checked = taskV2Schema.safeParse({ ...next, id: row.task_id });
    if (!checked.success) return { ok: false, why: `the widened contract is invalid: ${checked.error.message.slice(0, 200)}` };
    const valid = { task: checked.data };
    const run = getRun(db, row.run_id);
    const attempt = getAttempt(db, row.id);
    if (!run?.pm_thread_id || !attempt) return { ok: false, why: "no PM thread or attempt to reopen" };
    const ready = await reopen.checkReopenable({ runId: row.run_id, taskId: row.task_id, run, attempt });
    if (!ready.ok) return { ok: false, why: ready.hint };
    const config = await ctx.configForRun(row.project_id, run);
    if (!config) return { ok: false, why: "Lane Pilot is not configured for this project" };
    updateTaskContract(db, row.task_id, valid.task);
    const changes = (["owns_paths", "test_removals"] as const)
      .filter((field) => JSON.stringify(old[field] ?? []) !== JSON.stringify(valid.task[field] ?? []))
      .map((field) => ({ field, from: old[field] ?? [], to: valid.task[field] ?? [] }));
    const reopened = await reopen.reopenAttempt({ projectId: row.project_id, runId: row.run_id, taskId: row.task_id, pmThreadId: run.pm_thread_id, attempt, threadId: ready.threadId,
      workspacePath: ready.workspacePath, config, contract: valid.task, reason: "Lane Pilot answered the writer's question by rule",
      turn: `Lane Pilot answers your question by rule: ${summary}\n\n${contractFixTurnPrompt({ question, changes })}`, qaAnswer: summary });
    if (!reopened.ok) { updateTaskContract(db, row.task_id, old); return { ok: false, why: reopened.hint }; }
    return { ok: true };
  }

  async function run(row: Row, question: string, now: number, doors: Doors): Promise<RuleResult | null> {
    const parsed = taskV2Schema.safeParse(getTask(db, row.task_id)?.contract);
    if (!parsed.success) return null;
    const task = parsed.data;
    const kind = classifyQuestion(question);

    if (kind.kind === "outside_paths") {
      if (ruleCount(row, "outside_paths")) return null;
      const plan = widened(row, task, kind.files);
      if ("why" in plan) { ctx.log(`question rule outside_paths on ${row.task_id}: not applied (${plan.why})`); return null; }
      const summary = `owns_paths now also names ${plan.files.join(", ")}; edit them and finish the task. Nothing else outside owns_paths changed.`;
      const fixed = await fixContract(row, task, { ...task, owns_paths: [...task.owns_paths, ...plan.files] }, question, summary);
      if (!fixed.ok) return record(row, "outside_paths", question, false, fixed.why, now);
      await markPathsWidened(bb.storage.kv as never, row.run_id, row.task_id, plan.files);
      return record(row, "outside_paths", question, true, `owns_paths += ${plan.files.join(", ")}; code critic strict (paths_widened)`, now);
    }

    if (kind.kind === "required_test_change") {
      if (ruleCount(row, "required_test_change") || !kind.files.length) return null;
      // Only a test the contract itself names: its acceptance, objective or plan.
      const text = `${task.acceptance.join("\n")}\n${task.objective}\n${getTaskPlan(db, row.task_id) ?? ""}`;
      const named = kind.files.filter((file) => text.includes(file) || text.includes(file.split("/").slice(-2).join("/")));
      if (!named.length || named.length !== kind.files.length) return null;
      if (kind.files.some((file) => fileBlockedByNeverTouch(file, task.never_touch))) return null;
      const outside = kind.files.filter((file) => !fileAllowedByOwns(file, task.owns_paths));
      const plan = outside.length ? widened(row, task, outside) : { files: [] as string[] };
      if ("why" in plan) { ctx.log(`question rule required_test_change on ${row.task_id}: not applied (${plan.why})`); return null; }
      // test_removals is what test_fit and the diff-hidden checker skip: a file named there may be edited or weakened, which is the task.
      const removals = [...new Set([...(task.test_removals ?? []), ...kind.files])];
      const summary = `the contract names ${kind.files.join(", ")} as a test the task changes, so test_fit now allows your edit of it${plan.files.length ? ` and owns_paths names it` : ""}; change only what the acceptance requires there and keep every other assertion.`;
      const fixed = await fixContract(row, task, { ...task, test_removals: removals, owns_paths: [...task.owns_paths, ...plan.files] }, question, summary);
      if (!fixed.ok) return record(row, "required_test_change", question, false, fixed.why, now);
      if (plan.files.length) await markPathsWidened(bb.storage.kv as never, row.run_id, row.task_id, plan.files);
      return record(row, "required_test_change", question, true, `test_removals += ${kind.files.join(", ")}${plan.files.length ? `; owns_paths += ${plan.files.join(", ")}` : ""}; reference_tests_edited keeps the critic strict`, now);
    }

    if (kind.kind === "sandbox") {
      // One try per task. The writer stops; the check that fails in the sandbox is then read by the failure classifier as an environment fault
      // (isEnvironmentCheckFailure), which parks and retries the task without a charge, and the self-repair pass collects what repeats.
      if (ruleCount(row, "sandbox")) return null;
      const said = await doors.answerWriter(`Not your code: ${kind.check ? `the check ${kind.check} fails` : "a check fails"} because of the sandbox. Stop here; change nothing more and do not try to work around the sandbox. Report what you finished and that this check could not run. Lane Pilot repairs the check environment. This is a report, not another question: do not start it with ASK_PM.`);
      return record(row, "sandbox", question, said, said ? `writer told to stop; environment failure goes to Lane Pilot's repair path${kind.check ? ` (${kind.check})` : ""}` : "the writer's thread cannot take the answer", now);
    }

    if (kind.kind === "already_done") {
      if (ruleCount(row, "already_done")) return null;
      // The proof: the baseline of this task ran every check on the base and all were green (verdict already_built). No accepted-with-no-change
      // outcome exists (an empty diff is «writer answered but changed no files»), so the task ends as satisfied: dependents go on.
      const baseline = getBaseline(db, row.run_id, row.task_id);
      if (!baseline || baseline.state !== "ran" || baseline.verdict !== "already_built") return null;
      await markTaskSatisfied(bb.storage.kv as never, row.project_id, row.task_id, "already satisfied on the base: every check passes there (baseline)");
      await doors.cancel(`already satisfied on the base ${baseline.baseSha?.slice(0, 10) ?? ""}: every verification command passes there, nothing to change`);
      return record(row, "already_done", question, true, `closed as satisfied: baseline ${baseline.id} already_built`, now);
    }
    return null;
  }

  return { run };
}
