import { taskFamily } from "@lane-pilot/contracts";
import { liveAttemptsOfRun } from "../../../storage";
import {
  TASK_WORDS_KEY,
  taskApproachKey,
  taskQuestionsKey,
  taskWordKey,
  type TaskApproachNote,
  type TaskWord,
} from "../../models/words";

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };

/** The attempt of the family that waits for the word right now (SMA ta_replace): the candidate the owner's next word is for. */
export function waitingAttemptId(db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } }, runId: string, family: string): string | undefined {
  return liveAttemptsOfRun(db as never, runId).find((row) => taskFamily(row.task_id) === family)?.id;
}

/** The owner's latest word on the family is «no»: the task is decided and nothing of it is paid for again (SMA cg_claim_refusal). */
export async function ownerSaidNo(kv: { get(key: string): Promise<unknown> }, runId: string, family: string): Promise<string | null> {
  const words = ((await kv.get(TASK_WORDS_KEY)) as Record<string, TaskWord[]> | null)?.[taskWordKey(runId, family)];
  const latest = [...(words ?? [])].reverse().find((word) => word.turn === "land");
  return latest?.decision === "no" ? latest.text : null;
}

/** Records the owner's word on a task family (the PM's lane_pilot_queue word and the task_word RPC of a screen or the CLI write the same). */
export async function recordTaskWord(kv: Kv, runId: string, family: string, decision: "yes" | "no", text: string, now = Date.now(), attemptId?: string | null): Promise<void> {
  const all = ((await kv.get(TASK_WORDS_KEY)) as Record<string, TaskWord[]> | null) ?? {};
  const key = taskWordKey(runId, family);
  all[key] = [...(all[key] ?? []), { turn: "land" as const, decision, text, at: now, ...(attemptId ? { attemptId } : {}) }].slice(-10);
  await kv.set(TASK_WORDS_KEY, all as never);
}

export async function recordTaskApproach(kv: Kv, runId: string, taskId: string, note: TaskApproachNote): Promise<void> {
  await kv.set(taskApproachKey(runId, taskId), note as never);
}

export async function readTaskApproach(kv: { get(key: string): Promise<unknown> }, runId: string, taskId: string): Promise<unknown> {
  return kv.get(taskApproachKey(runId, taskId));
}

export async function recordTaskQuestions(kv: Kv, runId: string, taskId: string, note: { questions: unknown; checkpoint: string | null; at: number }): Promise<void> {
  await kv.set(taskQuestionsKey(runId, taskId), note as never);
}
