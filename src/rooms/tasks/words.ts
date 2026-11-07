/**
 * The owner's word on a task (SMA map: Authorized by a person, Two human decisions, Approving, Copy goes with approval). With owner.words on,
 * an accepted task lands on main only after the owner said yes to it: the PM asks him (lane_pilot_ask_owner) and records his answer with
 * lane_pilot_queue {action:"word"}; the word holds for the whole task family, so a redo needs no second one. Off, nothing waits.
 */
export type TaskWord = { turn: "land"; decision: "yes" | "no"; text: string; at: number };

export const TASK_WORDS_KEY = "lp.task.words";
/** A verified attempt waits for its landing decision for at most six hours. */
export const OWNER_WORD_WAIT_MS = 6 * 3600_000;

/**
 * The setting owner.words: `on` (every verified task waits for the word), `risky` (only a task of risk high; the default) or `off`.
 * SMA waits for a person at these turns (map 481d75c2: Authorized by a person, Two human decisions, Issue gate, Person accepts the wave,
 * Plan row awaits a word, Draft awaits a person); the owner asked for Lane Pilot one in one with it, its person steps included (2026-10-29),
 * then found a two-test fix waiting hours for his «да» while it held its area (SelfyStudio, 2026-10-31) and chose: the word for risky
 * tasks only. The other person steps (a phase's turns, a forge draft, a permit) keep asking on `risky` as on `on`.
 * LANE_PILOT_OWNER_WORDS_DEFAULT changes the default where no setting says (the test suite runs the machine path with it off).
 */
export type OwnerWordsMode = "on" | "risky" | "off";
export const ownerWordsMode = (settings: Readonly<Record<string, unknown>>): OwnerWordsMode => {
  const raw = String(settings["owner.words"] ?? process.env.LANE_PILOT_OWNER_WORDS_DEFAULT ?? "risky");
  return raw === "off" ? "off" : raw === "on" ? "on" : "risky";
};
/** Is the owner's word asked anywhere (the person steps): everything but `off`. */
export const ownerWordsOn = (settings: Readonly<Record<string, unknown>>) => ownerWordsMode(settings) !== "off";
/** Does this task's landing wait for the word: every task on `on`, a task of risk high or critical on `risky`, none on `off`. */
export const landingWordAsked = (settings: Readonly<Record<string, unknown>>, risk: string | undefined): boolean => {
  const mode = ownerWordsMode(settings);
  return mode === "on" || (mode === "risky" && (risk === "high" || risk === "critical"));
};
export const taskWordKey = (runId: string, family: string) => `${runId}:${family}`;

/** Why the landing waits, or null: the owner's latest word on the task family decides. */
export function landingWordGap(ownerWords: boolean, words: readonly TaskWord[] | undefined): string | null {
  if (!ownerWords) return null;
  const latest = [...(words ?? [])].reverse().find((word) => word.turn === "land");
  if (!latest) return "owner_word: owner.words is on — the task is verified and waits for the owner's word to land on main; ask him with lane_pilot_ask_owner, record it with lane_pilot_queue {action:\"word\", taskId, decision, text}, then send the task again (its writer redoes nothing, the same thread merges)";
  if (latest.decision === "no") return `owner_word: the owner said no to this task — ${latest.text}`;
  return null;
}

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };

/** Records the owner's word on a task family (the PM's lane_pilot_queue word and the task_word RPC of a screen or the CLI write the same). */
export async function recordTaskWord(kv: Kv, runId: string, family: string, decision: "yes" | "no", text: string, now = Date.now()): Promise<void> {
  const all = ((await kv.get(TASK_WORDS_KEY)) as Record<string, TaskWord[]> | null) ?? {};
  const key = taskWordKey(runId, family);
  all[key] = [...(all[key] ?? []), { turn: "land" as const, decision, text, at: now }].slice(-10);
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
