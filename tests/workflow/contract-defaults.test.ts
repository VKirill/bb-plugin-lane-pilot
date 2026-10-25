import { describe, expect, it } from "vitest";
import { withContractDefaults } from "../../src/rooms/workflow/server/workflow-executors";
import { validateTaskV2 } from "../../src/rooms/tasks/task-v2";

// A planner agent wrote the work but not the envelope; the lint refused it three times and the small-task graph stopped for the owner
// (issue-quick wfrun_8adbad9a…, 2026-10-25). The envelope is filled the same way every time; what the planner wrote wins.
describe("a planner's task gets the task-v2 envelope", () => {
  const planner = { id: "T1", title: "Append license section", objective: "add a license section", read_first: ["README.md"], owns_paths: ["README.md"],
    files: [{ path: "README.md", action: "modify", target: "end of file", change: "append the license section" }], acceptance: ["grep -c '^## Лицензия$' README.md prints 1"], verification: ["grep -q '^## Лицензия$' README.md"] };
  it("validates once the envelope is filled", () => {
    const filled = withContractDefaults(planner);
    expect(filled).toMatchObject({ schema_version: 2, risk: "medium", lane: "default", verify: "tests", expected_outputs: ["README.md"], verification: [{ command: "grep -q '^## Лицензия$' README.md", cwd: "." }] });
    const result = validateTaskV2({ ...filled, project_cwd: "/tmp/sandbox" });
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
  it("keeps what the planner wrote", () => {
    expect(withContractDefaults({ ...planner, risk: "low", lane: "ui", verify: "smoke" })).toMatchObject({ risk: "low", lane: "ui", verify: "smoke" });
  });
});

describe("a check written as prose", () => {
  it("runs its first code span, not the sentence", async () => {
    const { commandOf } = await import("../../src/rooms/workflow/server/workflow-executors");
    expect(commandOf("`npm test > /tmp/t1-test.log 2>&1; echo $?` prints `0`")).toBe("npm test > /tmp/t1-test.log 2>&1; echo $?");
    expect(commandOf("npm test")).toBe("npm test");
  });
});
