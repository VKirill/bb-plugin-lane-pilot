/**
 * The owner's word on a task (SMA map: Authorized by a person, Two human decisions, Approving, Copy goes with approval). With owner.words on,
 * an accepted task lands on main only after the owner said yes to it: the PM asks him (lane_pilot_ask_owner) and records his answer with
 * lane_pilot_queue {action:"word"}; the word holds for the whole task family, so a redo needs no second one. Off, nothing waits.
 */
import { OWNER_WORDS_KEY } from "../settings";
import { sensitiveHits, type StepEvidence } from "./sensitive";

export type TaskWord = { turn: "land"; decision: "yes" | "no"; text: string; at: number; /** The attempt (the candidate tree) the word was given for: a yes is revoked when another candidate replaces it (SMA ta_replace). */ attemptId?: string | null };

export const TASK_WORDS_KEY = "lp.task.words";
/** A verified attempt waits for its landing decision for at most six hours. */
export const OWNER_WORD_WAIT_MS = 6 * 3600_000;

export type OwnerWordsMode = "on" | "risky" | "sensitive" | "off";
export const ownerWordsMode = (settings: Readonly<Record<string, unknown>>): OwnerWordsMode => {
  const raw = String(settings[OWNER_WORDS_KEY] ?? process.env.LANE_PILOT_OWNER_WORDS_DEFAULT ?? "sensitive");
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

/** The writer's approach note for a task (written when its attempt finishes). */
export const taskApproachKey = (runId: string, taskId: string) => `lp.task.approach:${runId}:${taskId}`;
export const taskQuestionsKey = (runId: string, taskId: string) => `lp.task.questions:${runId}:${taskId}`;

export type TaskApproachNote = { approach: unknown; lesson: unknown; noLessonReason: unknown; referenceTestEdits: unknown; at: number };
