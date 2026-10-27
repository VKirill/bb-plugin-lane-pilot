import { questionKind } from "../../tasks";

/**
 * A writer's question nobody answers must not hold the task (and its folder) forever. After WRITER_QUESTION_WAIT_MS the machine answers
 * once with the safest default (question-timeout.ts); a writer that asks again after it is ended, not waited for (finish.ts).
 */
export const WRITER_QUESTION_WAIT_MS = 60 * 60_000;

/** Said in the PM's note to the writer's question, so the PM knows what happens when it does not answer. */
export const WRITER_QUESTION_WAIT_TEXT = "If nobody answers within an hour the machine answers a contract or sandbox question with the safest default (stay inside owns_paths and the checks as written, report what cannot be met) and the writer continues. A product decision (what the product should do, wording, which behaviour is live) is never defaulted: the attempt ends with the question in its reason and it goes to the owner's list.";

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
  "Nobody answered your question in time, so the machine answers with the safest default: do not widen anything.",
  "Keep owns_paths, never_touch, expected_outputs and the verification commands exactly as written. Add no paths, edit nothing outside owns_paths, change no check.",
  "Where your question offered two options, take the narrower one: the one that keeps the existing behaviour and touches fewer files.",
  "Do the part of the task that fits inside owns_paths. For what still cannot be done inside them, change nothing, and name in your final report which acceptance item is unmet and why.",
  "This is a report, not another question: do not start your answer with NEEDS_HUMAN.",
].join("\n");

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };
const key = (runId: string, taskId: string) => `writer-question-default:${runId}:${taskId}`;

export async function markAnsweredByDefault(kv: Kv, runId: string, taskId: string, at: number): Promise<void> {
  await kv.set(key(runId, taskId), at as never).catch(() => undefined);
}

export async function wasAnsweredByDefault(kv: Kv, runId: string, taskId: string): Promise<boolean> {
  return typeof await kv.get(key(runId, taskId)).catch(() => null) === "number";
}
