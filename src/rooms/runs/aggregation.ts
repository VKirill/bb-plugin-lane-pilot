import type { AttemptState, RunState } from "./state-machine";

const TERMINAL = new Set<AttemptState>(["accepted", "blocked", "canceled"]);
const OPEN = new Set<AttemptState>([
  "queued", "spawn_requested", "spawn_unknown", "spawn_rejected", "running",
  "provider_error", "timeout", "empty_output", "validation_failed", "cancel_requested",
]);

export function aggregateRun(taskStates: AttemptState[]): RunState {
  if (taskStates.length === 0) return "pending";
  if (taskStates.every((state) => state === "accepted")) return "accepted";
  if (taskStates.every((state) => state === "accepted" || state === "blocked")) return "blocked";
  if (taskStates.some((state) => OPEN.has(state) || !TERMINAL.has(state))) return "running";
  return "blocked";
}
