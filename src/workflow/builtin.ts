import analyzePlanExecute from "../../workflows/analyze-plan-execute.json";
import type { Workflow } from "./schema";
import { parseWorkflow } from "./validate";

/** The workflows that ship with Lane Pilot (`workflows/*.json`, inlined by the bundler). Add a file here to add one. */
export const BUILTIN_SOURCES: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: "analyze-plan-execute.json", value: analyzePlanExecute },
];

export const ANALYZE_PLAN_EXECUTE = "analyze-plan-execute";

const parsed = new Map<string, Workflow>();
for (const source of BUILTIN_SOURCES) {
  const workflow = parseWorkflow(source.value, { resolve: (id) => parsed.get(id) ?? null });
  parsed.set(workflow.id, workflow);
}

export const builtinWorkflows = (): Workflow[] => [...parsed.values()];
export const builtinWorkflow = (id: string, version?: number): Workflow | null => {
  const found = parsed.get(id) ?? null;
  return found && (version === undefined || found.version === version) ? found : null;
};
