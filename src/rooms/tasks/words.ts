/**
 * The owner's word on a task (SMA map: Authorized by a person, Two human decisions, Approving, Copy goes with approval). With owner.words on,
 * an accepted task lands on main only after the owner said yes to it: the PM asks him (lane_pilot_ask_owner) and records his answer with
 * lane_pilot_queue {action:"word"}; the word holds for the whole task family, so a redo needs no second one. Off, nothing waits.
 */
import { taskFamily } from "@lane-pilot/contracts";
import { liveAttemptsOfRun } from "../storage";
import { sensitiveHits, type StepEvidence } from "./sensitive";

export type TaskWord = { turn: "land"; decision: "yes" | "no"; text: string; at: number; /** The attempt (the candidate tree) the word was given for: a yes is revoked when another candidate replaces it (SMA ta_replace). */ attemptId?: string | null };

export const TASK_WORDS_KEY = "lp.task.words";
/** A verified attempt waits for its landing decision for at most six hours. */
export const OWNER_WORD_WAIT_MS = 6 * 3600_000;

/**
 * The setting owner.words: `on` (every verified task waits for the word), `risky` (only a task of risk high or critical), `sensitive` (the
 * default: only a step in one of three classes — money, database migrations and destructive data operations, a deploy to production; see
 * sensitive.ts) or `off`.
 * SMA waits for a person at these turns (map 481d75c2: Authorized by a person, Two human decisions, Issue gate, Person accepts the wave,
 * Plan row awaits a word, Draft awaits a person); the owner asked for Lane Pilot one in one with it, its person steps included (2026-10-29),
 * then found a two-test fix waiting hours for his «да» while it held its area (SelfyStudio, 2026-10-31) and chose: the word for risky
 * tasks only. On 2026-11-14, with a strong plan critic, a strict code critic and a cross-family verifier of high findings behind a high-risk
 * task, he narrowed it again: his word only for money, data and production deploys; everything else lands by itself, whatever its risk.
 * The other person steps (a phase's turns, a forge draft, a permit) follow the same rule: on `on` and `risky` they ask as before, on
 * `sensitive` only a step that is itself in the three classes asks, on `off` none.
 * LANE_PILOT_OWNER_WORDS_DEFAULT changes the default where no setting says (the test suite runs the machine path with it off).
 */
export type OwnerWordsMode = "on" | "risky" | "sensitive" | "off";
export const ownerWordsMode = (settings: Readonly<Record<string, unknown>>): OwnerWordsMode => {
  const raw = String(settings["owner.words"] ?? process.env.LANE_PILOT_OWNER_WORDS_DEFAULT ?? "sensitive");
  return raw === "off" ? "off" : raw === "on" ? "on" : raw === "risky" ? "risky" : "sensitive";
};
/**
 * Is the owner's word asked at this person step (a phase's turns, a forge draft, a contract's clarification, a permit): always on `on` and
 * `risky`, never on `off`, on `sensitive` only when the step itself is in the money / data / production-deploy classes (`step` is its
 * evidence; without it nothing is known and nothing asks).
 */
export const ownerWordsOn = (settings: Readonly<Record<string, unknown>>, step?: StepEvidence): boolean => {
  const mode = ownerWordsMode(settings);
  return mode === "on" || mode === "risky" || (mode === "sensitive" && !!step && sensitiveHits(step).length > 0);
};
/**
 * Does this task's landing wait for the word: every task on `on`, a task of risk high or critical on `risky`, a task whose evidence (changed
 * paths, check commands, text) is in the three classes on `sensitive` (whatever its risk), none on `off`.
 */
export const landingWordAsked = (settings: Readonly<Record<string, unknown>>, risk: string | undefined, step?: StepEvidence): boolean => {
  const mode = ownerWordsMode(settings);
  return mode === "on" || (mode === "risky" && (risk === "high" || risk === "critical")) || (mode === "sensitive" && !!step && sensitiveHits(step).length > 0);
};
export const taskWordKey = (runId: string, family: string) => `${runId}:${family}`;

/** The attempt of the family that waits for the word right now (SMA ta_replace): the candidate the owner's next word is for. */
export function waitingAttemptId(db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } }, runId: string, family: string): string | undefined {
  return liveAttemptsOfRun(db as never, runId).find((row) => taskFamily(row.task_id) === family)?.id;
}

/** Why the landing waits, or null: the owner's latest word on the task family decides. */
export function landingWordGap(ownerWords: boolean, words: readonly TaskWord[] | undefined, attemptId?: string): string | null {
  if (!ownerWords) return null;
  const latest = [...(words ?? [])].reverse().find((word) => word.turn === "land");
  if (!latest) return "owner_word: owner.words is on — the task is verified and waits for the owner's word to land on main; ask him with lane_pilot_ask_owner, record it with lane_pilot_queue {action:\"word\", taskId, decision, text}, then send the task again (its writer redoes nothing, the same thread merges)";
  if (latest.decision === "no") return `owner_word: the owner said no to this task — ${latest.text}`;
  // The yes was given for another candidate (SMA ta_replace): a redo or a changed tree asks for the word again.
  if (attemptId && latest.attemptId && latest.attemptId !== attemptId) return `owner_word: the owner's yes was given for another candidate of this task (attempt ${latest.attemptId}); ask him for the word on this one`;
  return null;
}

/** The owner's latest word on the family is «no»: the task is decided and nothing of it is paid for again (SMA cg_claim_refusal). */
export async function ownerSaidNo(kv: { get(key: string): Promise<unknown> }, runId: string, family: string): Promise<string | null> {
  const words = ((await kv.get(TASK_WORDS_KEY)) as Record<string, TaskWord[]> | null)?.[taskWordKey(runId, family)];
  const latest = [...(words ?? [])].reverse().find((word) => word.turn === "land");
  return latest?.decision === "no" ? latest.text : null;
}

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };

/** Records the owner's word on a task family (the PM's lane_pilot_queue word and the task_word RPC of a screen or the CLI write the same). */
export async function recordTaskWord(kv: Kv, runId: string, family: string, decision: "yes" | "no", text: string, now = Date.now(), attemptId?: string | null): Promise<void> {
  const all = ((await kv.get(TASK_WORDS_KEY)) as Record<string, TaskWord[]> | null) ?? {};
  const key = taskWordKey(runId, family);
  all[key] = [...(all[key] ?? []), { turn: "land" as const, decision, text, at: now, ...(attemptId ? { attemptId } : {}) }].slice(-10);
  await kv.set(TASK_WORDS_KEY, all as never);
}

/** The writer's approach note for a task (written when its attempt finishes; the cockpit's task card reads it). */
export const taskApproachKey = (runId: string, taskId: string) => `lp.task.approach:${runId}:${taskId}`;
export const taskQuestionsKey = (runId: string, taskId: string) => `lp.task.questions:${runId}:${taskId}`;

export type TaskApproachNote = { approach: unknown; lesson: unknown; noLessonReason: unknown; referenceTestEdits: unknown; at: number };

export async function recordTaskApproach(kv: Kv, runId: string, taskId: string, note: TaskApproachNote): Promise<void> {
  await kv.set(taskApproachKey(runId, taskId), note as never);
}

export async function readTaskApproach(kv: { get(key: string): Promise<unknown> }, runId: string, taskId: string): Promise<unknown> {
  return kv.get(taskApproachKey(runId, taskId));
}

export async function recordTaskQuestions(kv: Kv, runId: string, taskId: string, note: { questions: unknown; checkpoint: string | null; at: number }): Promise<void> {
  await kv.set(taskQuestionsKey(runId, taskId), note as never);
}
