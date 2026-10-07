import lpTaskPipeline from "../../workflows/lp-task-pipeline.json";
import type { Workflow } from "./schema";
import { parseWorkflow } from "./validate";

/** The workflows that ship with Lane Pilot (`workflows/*.json`, inlined by the bundler). Add a file here to add one. */
export const BUILTIN_SOURCES: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: "lp-task-pipeline.json", value: lpTaskPipeline },
];

/** The per-task pipeline every dispatch runs through (PM read, critiques, ownership base, writer). */
export const LP_TASK_PIPELINE = "lp-task-pipeline";

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
