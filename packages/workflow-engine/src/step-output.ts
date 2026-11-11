import { MissingValueError } from "./expr";
import type { Field, GraphNode as WorkflowNode } from "./schema";
import { engineOwnsOutcome } from "./lower";
import { checkOutput, honestExit } from "./values";
import { contractProblems, describeProblems, hasContractProblems } from "./contract";

/** The output of a step against its declared fields and then its contract (`produces`, `gates`): the first problem throws, so the step is not done. */
export function checkStepOutput(node: WorkflowNode, fields: readonly Field[] | "unknown", output: Record<string, unknown>): Record<string, unknown> {
  const kept = fields === "unknown" ? output : checkOutput(fields, output);
  const exit = fields !== "unknown" && fields.some((field) => field.name === "outcome") ? honestExit(kept) : null;
  if (exit) {
    // Where the graph does not route on the outcome itself, a step whose agent says it has no result is not done: the run stops with the agent's reason.
    if (engineOwnsOutcome(node)) throw new MissingValueError(`agent_${exit}`, `${node.id}: ${blockerText(kept)}`);
    return kept;
  }
  const problems = contractProblems(node, kept);
  if (hasContractProblems(problems)) throw new MissingValueError(problems.produces.length ? "artifact_invalid" : "gate_failed", `${node.id}: ${describeProblems(problems).join("; ")}`);
  return kept;
}
/** What the agent said it needs (or why it could not), for the run's reason: the blocker first, then the handoff. */
const blockerText = (output: Record<string, unknown>): string => {
  const blocker = output.blocker && typeof output.blocker === "object" ? output.blocker as Record<string, unknown> : {};
  const needs = typeof blocker.needs === "string" && blocker.needs.trim() ? `needs ${blocker.needs.trim()}${typeof blocker.from === "string" && blocker.from.trim() ? ` from ${blocker.from.trim()}` : ""}` : "";
  return (needs || String(output.handoff ?? "")).replace(/\s+/g, " ").slice(0, 600);
};
