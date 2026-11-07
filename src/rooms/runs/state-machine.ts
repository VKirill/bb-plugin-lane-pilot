// The attempt state machine is a rooms-level bottom module shared by storage (transitionAttempt) and runs; this barrel keeps the runs room's surface.
export { ATTEMPT_STATES, IllegalTransitionError, MAIN_ATTEMPT_LIMIT, OPERATIONAL_MOVES, RETRY_ELIGIBLE, RUN_STATES, TRANSITION_TABLE, isLegalMove, nextAttemptState, resolveTransition, retryAction } from "../state-machine";
export type { AttemptState, RunState, TransitionEvent, TransitionRow } from "../state-machine";
