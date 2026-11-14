import { questionKind } from "../../tasks";
import { bestEffort, BestEffortLog} from "@lane-pilot/kit";

/**
 * A writer's question nobody answers must not hold the task (and its folder) forever. After `writer.question_wait_min` (catalog s586; this
 * constant is its default) the machine acts on it once: the second pilot answers, narrows or hands over (second-pilot.ts), or, with
 * `writer.auto_return` off, the safest default answers (question-timeout.ts); a writer that asks again after it is ended, not waited for (finish.ts).
 */
export const DEFAULT_QUESTION_WAIT_MIN = 120;
/** A PM that works in its thread right now answers first: the machine waits this long before it acts on a question that no rule settled. */
export const PM_ACTIVE_GRACE_MS = 5 * 60_000;
export const WRITER_QUESTION_WAIT_MS = DEFAULT_QUESTION_WAIT_MIN * 60_000;

/** The one statement of who answers a writer's question; the writer brief, the PM prompt, the tools and the skills say this and nothing else. */
export const WHO_ANSWERS = "Who answers a writer's question: the writer asks with `ASK_PM:` as the first line of its answer (the old `NEEDS_HUMAN:` still reads). Lane Pilot answers it itself within minutes, by rule first (a named file outside owns_paths is added to owns_paths, up to five files, never never_touch or another live task's; a test the contract itself names becomes an allowed edit; a sandbox fault is not the writer's; a task already done on the base is closed), then the second pilot, a read-only helper with the contract, plan and project memory; the PM may answer first with lane_pilot_answer_writer. A person is asked only for a secret or access, money, an irreversible act, or a product decision (what the product should do). There is no other channel for questions: not QUESTIONS.md, not the owner by default.";

/** Said in the PM's note to the writer's question, so the PM knows what happens when it does not answer. */
export const WRITER_QUESTION_WAIT_TEXT = `${WHO_ANSWERS} The second pilot answers, narrows the task into a new one that needs no human, or hands the question to the owner when it is a product decision; a PM working in this thread gets five minutes first. writer.question_wait_min is only the upper bound a question may stand.`;

/** A question about the contract or the sandbox (paths, checks, tooling): the narrower default answers it. */
const CONTRACT_OR_SANDBOX = /owns_paths|never_touch|expected_outputs|verification|sandbox|seatbelt|bubblewrap|\bchecks?\b|vitest|jest|typecheck|\btsc\b|\bnpm\b|\bnpx\b|exit code|lane pilot|checkout|worktree|no-git|\bcontract\b|контракт|песочниц|проверк/i;
/** Wording of a choice that the five-kind classifier (tasks/rails.ts questionKind) files as a clarification. */
const CHOICE_WORDING = /\bshould (?:we|i|the|a|an)\b|\bwhether\b|\bor should\b|(?:^|\s)ли(?=[\s?,.]|$)|какие|какое|каким|нужно ли|стоит ли/i;

/**
 * A question whose answer is the product's (a decision or a contradiction between requirements) and not the contract's: the machine's
 * narrower default must not decide it, because it would build the owner's product by a rule of thumb (question-timeout.ts).
 */
export function isProductDecision(question: string): boolean {
  if (CONTRACT_OR_SANDBOX.test(question)) return false;
  const kind = questionKind(question);
  return kind === "decision" || kind === "contradiction" || (kind === "clarification" && CHOICE_WORDING.test(question));
}

export const SAFE_DEFAULT_ANSWER = [
  "The machine answers with the safest default: take the narrower reading.",
  "Do the part of the task that fits inside owns_paths as written. A file outside them is added by Lane Pilot only when your question names it and the limits allow; do not edit one that is not owned, and change no check.",
  "Where your question offered two options, take the narrower one: the one that keeps the existing behaviour and touches fewer files.",
  "For what still cannot be done, change nothing, and name in your final report which acceptance item is unmet and why.",
  "This is a report, not another question: do not start your answer with ASK_PM.",
].join("\n");

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };
const key = (runId: string, taskId: string) => `writer-question-default:${runId}:${taskId}`;

export async function markAnsweredByDefault(kv: Kv, runId: string, taskId: string, at: number, log?: BestEffortLog): Promise<void> {
  await bestEffort(log ?? ((message: string) => {}), "writer question default mark", kv.set(key(runId, taskId), at as never), undefined);
}

export async function wasAnsweredByDefault(kv: Kv, runId: string, taskId: string): Promise<boolean> {
  return typeof await kv.get(key(runId, taskId)) === "number";
}
