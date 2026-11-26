import { CHECK_VERDICTS, factVerdictFromCheck } from "@lane-pilot/contracts";
import type { CheckVerdict, FactVerdict } from "@lane-pilot/contracts";
import { MissingValueError } from "./expr";
import type { StepState } from "./journal";
import type { Field, GraphNode as WorkflowNode } from "./schema";
import { engineOwnsOutcome } from "./lower";
import { checkOutput, honestExit } from "./values";
import { contractProblems, describeProblems, hasContractProblems } from "./contract";

export { factVerdictFromCheck };
export type { CheckVerdict, FactVerdict };

const CHECK_VERDICT_SET = new Set<string>(CHECK_VERDICTS);

function asCheckVerdict(value: unknown): CheckVerdict | null {
  return typeof value === "string" && CHECK_VERDICT_SET.has(value) ? (value as CheckVerdict) : null;
}

function extractCheckVerdict(output: Record<string, unknown> | null | undefined, detail: unknown): CheckVerdict | null {
  const detailObj = detail && typeof detail === "object" && !Array.isArray(detail) ? detail as Record<string, unknown> : null;
  const fromDetail = asCheckVerdict(detailObj?.checkVerdict ?? detailObj?.verdict);
  if (fromDetail) return fromDetail;
  if (!output) return null;
  const reading = output.reading && typeof output.reading === "object" && !Array.isArray(output.reading)
    ? output.reading as Record<string, unknown>
    : null;
  return asCheckVerdict(output.checkVerdict ?? reading?.verdict ?? output.verdict);
}

function inferFailureClass(errorCode: string | null | undefined, error: string | null | undefined): string {
  if (errorCode && errorCode.trim()) return errorCode.trim();
  if (!error || !error.trim()) return "step_failed";
  const prefix = error.split(":", 1)[0]?.trim() ?? "";
  return /^[a-z0-9_]+$/i.test(prefix) ? prefix : "step_failed";
}

/** Derive the persisted step verdict and failure_class from step state and any CheckVerdict payload. */
export function stepFactVerdict(input: {
  state: Extract<StepState, "succeeded" | "failed" | "skipped" | "canceled">;
  checkVerdict?: CheckVerdict | null;
  output?: Record<string, unknown> | null;
  detail?: unknown;
  error?: string | null;
  errorCode?: string | null;
}): { verdict: FactVerdict; failureClass: string | null } {
  if (input.state === "skipped") return { verdict: "not_run", failureClass: null };
  const explicit = input.checkVerdict ?? extractCheckVerdict(input.output, input.detail);
  if (explicit) return factVerdictFromCheck(explicit);
  if (input.state === "canceled") {
    return {
      verdict: "not_run",
      failureClass: input.errorCode ?? (input.error ? inferFailureClass(null, input.error) : null),
    };
  }
  if (input.state === "succeeded") return { verdict: "pass", failureClass: null };
  return { verdict: "fail", failureClass: inferFailureClass(input.errorCode, input.error) };
}

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
