import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow, parseWorkflowObject, validateWorkflow } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";

const ROOT = resolve(__dirname, "../..");
const WORKFLOWS_DIR = join(ROOT, "workflows");

function loadCatalog(): { byId: Map<string, Workflow>; files: Array<{ file: string; raw: string }> } {
  const files = readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((file) => ({ file, raw: readFileSync(join(WORKFLOWS_DIR, file), "utf8") }));

  const parsed = new Map<string, Workflow>();
  for (const { raw } of files) {
    try {
      const result = parseWorkflowObject(JSON.parse(raw));
      if (result.success) parsed.set(result.data.id, result.data);
    } catch {
      // Reported by loadWorkflow below.
    }
  }
  return { byId: parsed, files };
}

describe("architecture: shipped workflows obey wait, skip_out, and judge session rails", () => {
  it("validates every workflow file without rail or validation errors", () => {
    const { byId, files } = loadCatalog();
    const resolveWf = (id: string) => byId.get(id) ?? null;
    const failures: Array<{ file: string; problems: string[] }> = [];

    for (const { file, raw } of files) {
      const loaded = loadWorkflow(raw, { resolve: resolveWf });
      if (!loaded.ok) {
        failures.push({
          file,
          problems: loaded.problems.filter((p) => p.level === "error").map((p) => `[${p.code}] ${p.message}`),
        });
        continue;
      }
      const problems = validateWorkflow(loaded.workflow, { resolve: resolveWf }).filter((p) => p.level === "error");
      if (problems.length > 0) {
        failures.push({ file, problems: problems.map((p) => `[${p.code}] ${p.message}`) });
      }
    }

    expect(failures).toEqual([]);
  });
});
