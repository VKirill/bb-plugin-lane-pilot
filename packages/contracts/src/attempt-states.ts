/** Attempt states still at work: queued, being spawned, running or being canceled. Every other state ended the attempt. */
export const OPEN_ATTEMPT_STATES = ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"] as const;

export function isOpenAttemptState(state: string): boolean {
  return (OPEN_ATTEMPT_STATES as readonly string[]).includes(state);
}

/** Ended attempt states (accepted, blocked, canceled). */
export const TERMINAL_ATTEMPT_STATES = ["accepted", "blocked", "canceled"] as const;

export function isTerminalAttemptState(state: string): boolean {
  return (TERMINAL_ATTEMPT_STATES as readonly string[]).includes(state);
}

/** Immutable final attempt states that never transition again. */
export const FINAL_ATTEMPT_STATES = ["accepted", "canceled"] as const;

export function isFinalAttemptState(state: string): boolean {
  return (FINAL_ATTEMPT_STATES as readonly string[]).includes(state);
}
