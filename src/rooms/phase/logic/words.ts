import { openQuestions } from "../stages";
import type { PhaseRecord, WordTurn } from "./record";


/** Blocking questions of a stage that nobody answered yet. */
export { openQuestions };

/** The owner's latest word at a turn. */
export const wordOf = (record: PhaseRecord, turn: WordTurn) => [...(record.words ?? [])].reverse().find((word) => word.turn === turn);

/**
 * The key of what the owner is shown for a word turn (SMA as_launchable): the plan at planning and issue, the drawing at
 * design. A yes records it; a later change to that very thing is not signed by the word and is asked again.
 */
export const wordKeyOf = (record: PhaseRecord, turn: WordTurn): string | null =>
  turn === "planning" || turn === "issue" ? record.plan?.sha ?? null
  : turn === "design" ? record.design?.drawing?.sha256 ?? null : null;
