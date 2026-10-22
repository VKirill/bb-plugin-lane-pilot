import type { HuntState, LadderStage } from "./types";

/**
 * The wall ladder (loop guard v2; Maslov, dialogue 2026-10-22: «3 ходки; если не помогли — меняется перспектива: big picture, подключаются
 * охотники с другой стороны; если ничего — беклог, дальше разбирается по полной»; owner default of 2026-10-22: two normal moves, the third
 * replaced by the hunt). The same ladder serves a class of failures (the night's repair rounds are its moves) and a task family (its
 * attempts are the moves). Never an infinite retry: every path ends in the backlog.
 *
 *   moves      -> `walks` failed moves (default 2) ->
 *   hunt       -> read-only hunters from other sides, their citations checked by code ->
 *   informed   -> ONE more move that carries what the hunt found; if it fails, or the hunt found nothing usable ->
 *   backlog    -> a register entry waiting for a person's term, and a full analysis at night.
 */
export type LadderState = { failedMoves: number; hunt: HuntState; afterHuntFailed: number };
export type LadderStep = { step: "move" | "hunt" | "wait_hunt" | "informed_move" | "backlog"; stage: LadderStage; why: string };

export function ladderStep(state: LadderState, walks = 2): LadderStep {
  if (state.hunt === "running") return { step: "wait_hunt", stage: "hunt", why: "the hunters are still reading" };
  if (state.hunt === "none") {
    if (state.failedMoves < walks) return { step: "move", stage: "moves", why: `move ${state.failedMoves + 1} of ${walks}` };
    return { step: "hunt", stage: "hunt", why: `${state.failedMoves} moves failed: change the perspective instead of a third move` };
  }
  if (state.hunt === "unknown") return { step: "backlog", stage: "backlog", why: "every hunter ended unknown or without a citation that holds" };
  if (state.afterHuntFailed === 0) return { step: "informed_move", stage: "informed", why: "one move that carries the hunters' findings" };
  return { step: "backlog", stage: "backlog", why: "the move informed by the hunt failed too" };
}

/** What a failed move does to the state: before the hunt it counts as a move, after a usable hunt as the informed move. */
export function afterFailedMove(state: LadderState): LadderState {
  if (state.hunt === "usable") return { ...state, afterHuntFailed: state.afterHuntFailed + 1 };
  if (state.hunt === "none") return { ...state, failedMoves: state.failedMoves + 1 };
  return state;
}
