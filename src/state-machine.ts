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
