/**
 * A writer's question nobody answers must not hold the task (and its folder) forever. After WRITER_QUESTION_WAIT_MS the machine answers
 * once with the safest default (question-timeout.ts); a writer that asks again after it is ended, not waited for (finish.ts).
 */
export const WRITER_QUESTION_WAIT_MS = 60 * 60_000;

/** Said in the PM's note to the writer's question, so the PM knows what happens when it does not answer. */
export const WRITER_QUESTION_WAIT_TEXT = "If nobody answers within an hour the machine answers with the safest default (stay inside owns_paths and the checks as written, report what cannot be met) and the writer continues.";

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
