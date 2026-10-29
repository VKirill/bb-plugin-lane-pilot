/**
 * The owner's word on a task (SMA map: Authorized by a person, Two human decisions, Approving, Copy goes with approval). With owner.words on,
 * an accepted task lands on main only after the owner said yes to it: the PM asks him (lane_pilot_ask_owner) and records his answer with
 * lane_pilot_queue {action:"word"}; the word holds for the whole task family, so a redo needs no second one. Off, nothing waits.
 */
export type TaskWord = { turn: "land"; decision: "yes" | "no"; text: string; at: number };

export const TASK_WORDS_KEY = "lp.task.words";

/**
 * Is the owner's word asked (setting owner.words): on unless the project turns it off. SMA waits for a person at these turns (map
 * 481d75c2: Authorized by a person, Two human decisions, Issue gate, Person accepts the wave, Plan row awaits a word, Draft awaits a
 * person); the owner asked for Lane Pilot one in one with it, its person steps included (2026-10-29). Before, it was off by default.
 * LANE_PILOT_OWNER_WORDS_DEFAULT changes the default where no setting says (the test suite runs the machine path with it off).
 */
export const ownerWordsOn = (settings: Readonly<Record<string, unknown>>) =>
  String(settings["owner.words"] ?? process.env.LANE_PILOT_OWNER_WORDS_DEFAULT ?? "on") !== "off";
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
  const all = ((await kv.get(TASK_WORDS_KEY).catch(() => null)) as Record<string, TaskWord[]> | null) ?? {};
  const key = taskWordKey(runId, family);
  all[key] = [...(all[key] ?? []), { turn: "land" as const, decision, text, at: now }].slice(-10);
  await kv.set(TASK_WORDS_KEY, all as never);
}
