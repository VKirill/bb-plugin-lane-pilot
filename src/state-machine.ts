export const ATTEMPT_STATES = [
  "queued",
  "spawn_requested",
  "spawn_unknown",
  "spawn_rejected",
  "running",
  "provider_error",
  "timeout",
  "empty_output",
  "validation_failed",
  "cancel_requested",
  "canceled",
  "accepted",
  "blocked",
] as const;

export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const RUN_STATES = ["pending", "running", "accepted", "blocked", "closed"] as const;
export type RunState = (typeof RUN_STATES)[number];

export type TransitionEvent =
  | "form_task"
  | "spawn_called"
  | "spawn_ok"
  | "spawn_explicit_error"
  | "spawn_network_error"
  | "reconcile_found"
  | "reconcile_not_found"
  | "reconcile_ambiguous"
  | "reconcile_error"
  | "retry"
  | "retry_exhausted"
  | "provider_error"
  | "wait_timeout"
  | "empty_output"
  | "validation_failed"
  | "checks_passed"
  | "cancel"
  | "cancel_observed";

export type TransitionRow = {
  from: AttemptState | null;
  event: TransitionEvent;
  to: AttemptState | "stay";
};

export const TRANSITION_TABLE: TransitionRow[] = [
  { from:null, event:"form_task", to:"queued" },
  { from:"queued", event:"spawn_called", to:"spawn_requested" },
  { from:"spawn_requested", event:"spawn_ok", to:"running" },
  { from:"spawn_requested", event:"spawn_explicit_error", to:"spawn_rejected" },
  { from:"spawn_requested", event:"spawn_network_error", to:"spawn_unknown" },
  { from:"spawn_unknown", event:"reconcile_found", to:"running" },
  { from:"spawn_unknown", event:"reconcile_not_found", to:"spawn_rejected" },
  { from:"spawn_unknown", event:"reconcile_ambiguous", to:"blocked" },
  { from:"spawn_unknown", event:"reconcile_error", to:"stay" },
  { from:"spawn_rejected", event:"retry", to:"queued" },
  { from:"spawn_rejected", event:"retry_exhausted", to:"blocked" },
  { from:"running", event:"provider_error", to:"provider_error" },
  { from:"running", event:"wait_timeout", to:"timeout" },
  { from:"running", event:"empty_output", to:"empty_output" },
  { from:"running", event:"validation_failed", to:"validation_failed" },
  { from:"running", event:"checks_passed", to:"accepted" },
  { from:"running", event:"cancel", to:"cancel_requested" },
  { from:"cancel_requested", event:"cancel_observed", to:"canceled" },
  { from:"provider_error", event:"retry", to:"queued" },
  { from:"provider_error", event:"retry_exhausted", to:"blocked" },
  { from:"timeout", event:"retry", to:"queued" },
  { from:"timeout", event:"retry_exhausted", to:"blocked" },
  { from:"empty_output", event:"retry", to:"queued" },
  { from:"empty_output", event:"retry_exhausted", to:"blocked" },
  { from:"validation_failed", event:"retry", to:"queued" },
  { from:"validation_failed", event:"retry_exhausted", to:"blocked" },
];

export const MAIN_ATTEMPT_LIMIT = 2;

export const RETRY_ELIGIBLE: AttemptState[] = [
  "spawn_rejected",
  "provider_error",
  "timeout",
  "empty_output",
  "validation_failed",
];

export function resolveTransition(from: AttemptState | null, event: TransitionEvent): AttemptState | "stay" {
  const row = TRANSITION_TABLE.find((item) => item.from === from && item.event === event);
  if (!row) throw new Error(`illegal transition ${from ?? "∅"} + ${event}`);
  return row.to;
}

export function nextAttemptState(from: AttemptState | null, event: TransitionEvent): AttemptState {
  const to = resolveTransition(from, event);
  if (to === "stay") {
    if (from === null) throw new Error("stay is not valid from null");
    return from;
  }
  return to;
}

export function retryAction(failed: AttemptState, usedAttempts: number): TransitionEvent {
  if (!RETRY_ELIGIBLE.includes(failed)) throw new Error(`retry is not legal from ${failed}`);
  return usedAttempts >= MAIN_ATTEMPT_LIMIT ? "retry_exhausted" : "retry";
}

/**
 * Moves the pipeline makes that §3.4's table does not list, each with the reason it exists. Anything not in the table or
 * here is a bug in the caller: `transitionAttempt` refuses it. Add a row only for a move the product needs, never to
 * silence a refusal.
 */
export const OPERATIONAL_MOVES: ReadonlyArray<{ from:AttemptState; to:AttemptState; why:string }> = [
  { from:"queued", to:"queued", why:"dispatch marks the attempt while its pm-read and plan critique run, then clears the mark" },
  { from:"spawn_requested", to:"spawn_requested", why:"a hot writer's turn that fell back to a fresh spawn for the same attempt asks again" },
  { from:"running", to:"running", why:"recovery stamps the writer thread it found on an attempt that is already running" },
  { from:"queued", to:"blocked", why:"a dispatch gate (pm-read, plan critique, dependencies, budget) ends the attempt before any writer" },
  { from:"spawn_requested", to:"blocked", why:"the run's budget or an internal error ends an attempt while its writer starts" },
  { from:"running", to:"blocked", why:"a gate after the writer (owns, critique, merge queue, budget) or an internal error ends the attempt with no failure state of its own" },
  { from:"cancel_requested", to:"blocked", why:"an internal error ends an attempt whose stop was requested" },
  { from:"blocked", to:"running", why:"the PM answered the writer's question: the same writer thread goes on" },
  { from:"queued", to:"accepted", why:"a mainfix whose failing checks already pass on main closes without a writer" },
  { from:"queued", to:"canceled", why:"canceled before any writer was asked for" },
  { from:"queued", to:"cancel_requested", why:"canceled while its dispatch stages run" },
  { from:"spawn_requested", to:"cancel_requested", why:"canceled while its writer was starting" },
  { from:"spawn_unknown", to:"cancel_requested", why:"canceled while its writer's thread is being found again" },
  { from:"running", to:"spawn_rejected", why:"reconcile found no thread for an attempt that was running: the writer is gone and the attempt retries like a rejected spawn" },
  ...(["cancel_requested", "blocked", "provider_error", "timeout", "empty_output", "validation_failed"] as const).map((from) =>
    ({ from, to:"accepted" as const, why:"the merge landed in main before the attempt's state caught up (a stop requested meanwhile or a reply lost): the work is in main, so it is accepted" })),
];

export class IllegalTransitionError extends Error {
  constructor(readonly attemptId:string, readonly from:string, readonly to:string) {
    super(`illegal attempt transition ${from} -> ${to} (attempt ${attemptId})`);
    this.name = "IllegalTransitionError";
  }
}

const LEGAL_MOVES:ReadonlySet<string> = new Set([
  ...TRANSITION_TABLE.filter((row) => row.from !== null).map((row) => `${row.from}>${row.to === "stay" ? row.from : row.to}`),
  ...OPERATIONAL_MOVES.map((row) => `${row.from}>${row.to}`),
]);

/** Whether an attempt may go from one state to the other: a row of the table, or an operational move above. */
export function isLegalMove(from:string, to:string):boolean {
  return LEGAL_MOVES.has(`${from}>${to}`);
}
