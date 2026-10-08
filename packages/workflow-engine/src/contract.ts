import { artifactDef, artifactExample, artifactId, checkProduces } from "./artifacts";
import type { ProducesSpec } from "./artifacts";
import { evalCondition, toExpr } from "./expr";
import type { Ref } from "./expr";
import type { Field } from "./schema";

/**
 * The checks a step's contract (W0) makes on its output: the `produces` against the artifact registry, and the `gates`,
 * conditions over the step's own fields in the language of `when`. The engine runs them on every step that ends; the agent
 * step runs them before it returns, so a bad answer can be put right by one repair turn instead of failing the step.
 */
export type ContractNode = { id: string; produces?: readonly ProducesSpec[] | undefined; gates?: readonly string[] | undefined };
export type ContractProblems = { produces: string[]; gates: string[] };

const valueAt = (value: unknown, path: readonly string[]): unknown => {
  let current = value;
  for (const part of path) {
    if (part === "length" && (Array.isArray(current) || typeof current === "string")) { current = current.length; continue; }
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

/** The problems of an output against the node's `produces` and `gates`; both lists are empty when the step may count as done. */
export function contractProblems(node: ContractNode, output: Record<string, unknown>): ContractProblems {
  const produces = node.produces?.length ? checkProduces(node.produces, output) : [];
  const gates: string[] = [];
  for (const gate of node.gates ?? []) {
    try {
      const expr = toExpr(gate, node.id);
      const read = (ref: Ref): { ran: boolean; value: unknown } => (ref.kind === "node" && ref.node === node.id ? { ran: true, value: valueAt(output, ref.path) } : { ran: false, value: undefined });
      if (!evalCondition(expr, { read, visits: () => 0 }, `gate "${gate}"`)) gates.push(`gate not met: ${gate}`);
    } catch (cause) {
      gates.push(`gate "${gate}" cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { produces, gates };
}

export const hasContractProblems = (problems: ContractProblems): boolean => problems.produces.length > 0 || problems.gates.length > 0;
export const describeProblems = (problems: ContractProblems): string[] => [...problems.produces, ...problems.gates];

/**
 * The repair turn for an answer that is JSON but breaks the step's contract: the problems, one example of each artifact it
 * should be (clipped), and the instruction not to redo the work.
 */
export function contractRepairPrompt(problems: ContractProblems, produces: readonly ProducesSpec[] | undefined, fieldsContract: string): string {
  const lines = ["Your JSON block does not meet this step's contract:", ...describeProblems(problems).slice(0, 10).map((problem) => `- ${problem}`)];
  for (const spec of produces ?? []) {
    const example = artifactExample(spec.kind, spec.version, 700);
    if (example) lines.push("", `Shape of ${artifactId(spec)}${spec.field ? ` (field "${spec.field}"${spec.each ? ", a list of them" : ""})` : ""}, an example:`, example);
  }
  lines.push("", fieldsContract, "Answer with the corrected block now; do not redo the work.");
  return lines.join("\n");
}

const fits = (field: Field, value: unknown): boolean => {
  switch (field.type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "enum": return typeof value === "string" && field.values!.includes(value);
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    default: return value !== undefined;
  }
};

/**
 * Values for the declared fields of a stubbed step that make its output a valid artifact of what it `produces` (the registry's
 * example, field by field): a dry run of a draft answers from these before the case's own stubs, so a stub is never invalid
 * only because it was made up.
 */
export function contractSample(produces: readonly ProducesSpec[] | undefined, fields: readonly Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of produces ?? []) {
    const example = artifactDef(spec.kind, spec.version)?.example;
    if (example === undefined) continue;
    if (spec.field !== undefined) {
      const field = fields.find((candidate) => candidate.name === spec.field);
      const value = spec.each ? [example] : example;
      if (field && fits(field, value)) out[spec.field] = value;
      continue;
    }
    if (typeof example !== "object" || example === null || Array.isArray(example)) continue;
    for (const [key, value] of Object.entries(example)) {
      const field = fields.find((candidate) => candidate.name === key);
      if (field && fits(field, value)) out[key] = value;
    }
  }
  return out;
}
