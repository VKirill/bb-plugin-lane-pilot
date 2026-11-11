import type { RunGoal } from "./goals";

/** The one goal of a request given as `title` or `text`: the same goal the PM intake names. No request in the inputs, no goal. */
export function requestGoals(inputs: Record<string, unknown>): RunGoal[] {
  const pick = (value: unknown) => typeof value === "string" ? value.trim().split("\n").find((line) => line.trim())?.trim() ?? "" : "";
  const title = (pick(inputs.title) || pick(inputs.text)).slice(0, 120);
  return title ? [{ id: "request", done_when: `The owner's request is done: ${title}`.slice(0, 600), evidence: "the workflow output status is closed and its comment says what changed", guess: true }] : [];
}
