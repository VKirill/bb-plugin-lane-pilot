import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// flow-docs F19: the drill's flow-contract check is red when a task's receipts name a stage lp-task-pipeline.json
// does not declare, or when a code-decided writer stage did not pass; green on the real pipeline's shape.
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));

function problems(receipts: Array<{ stage_id: string; state: string }>) {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({"allowed": sorted(m.flow_contract_stages()), "problems": m.flow_contract_problems(${JSON.stringify(receipts)}, m.flow_contract_stages())}))
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) throw new Error(res.stderr.slice(0, 600));
  return JSON.parse(res.stdout.trim()) as { allowed: string[]; problems: string[] };
}

describe("the drill's flow contract (lp-task-pipeline receipts)", () => {
  const green = [
    { stage_id: "pm-read", state: "skipped" }, { stage_id: "plan-critique", state: "skipped" },
    { stage_id: "specialist-review", state: "skipped" }, { stage_id: "writer-agent", state: "passed" },
    { stage_id: "verification", state: "passed" }, { stage_id: "code-critique", state: "skipped" },
    { stage_id: "plan-fact", state: "passed" }, { stage_id: "acceptance-receipt", state: "passed" },
  ];

  it("accepts the receipts a disabled-critiques run produces", () => {
    expect(problems(green).problems).toEqual([]);
  });

  it("is red when a stage the graph does not declare receipts", () => {
    const out = problems([...green, { stage_id: "night-reviewer", state: "passed" }]);
    expect(out.problems.some((line) => line.includes("night-reviewer"))).toBe(true);
  });

  it("is red when acceptance-receipt did not pass", () => {
    const out = problems(green.map((row) => row.stage_id === "acceptance-receipt" ? { ...row, state: "failed" } : row));
    expect(out.problems.some((line) => line.includes("acceptance-receipt"))).toBe(true);
  });

  it("reads the stage names from the real workflow file, not a copy", () => {
    const { allowed } = problems([]);
    for (const stage of ["pm-read", "writer-agent", "verification", "acceptance-receipt", "browser-qa"])
      expect(allowed).toContain(stage);
    expect(allowed).not.toContain("quality-mode");
  });
});
