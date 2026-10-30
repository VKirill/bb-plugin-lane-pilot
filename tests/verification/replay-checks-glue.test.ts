import { describe, expect, it } from "vitest";
import { gluedCheckCommand, glueReplayCommands } from "../../src/rooms/verification/server";
import { lintContract, type LintInput } from "../../src/rooms/tasks/server/contract-lint";
import type { TaskV2 } from "../../src/rooms/contracts";

describe("gluedCheckCommand (G2/G8: a chain of one runner is one run)", () => {
  it("merges vitest runs that differ only in the test-file filter", () => {
    expect(gluedCheckCommand("npx vitest run a.test.ts && npx vitest run b.test.ts")).toBe("npx vitest run a.test.ts b.test.ts");
    expect(gluedCheckCommand("npx vitest run --reporter=dot a.test.ts; npx vitest run --reporter=dot b.test.ts && npx vitest run --reporter=dot c.test.ts"))
      .toBe("npx vitest run --reporter=dot a.test.ts b.test.ts c.test.ts");
  });
  it("collapses a check that repeats one command", () => {
    expect(gluedCheckCommand("npm test && npm test && npm test")).toBe("npm test");
  });
  it("keeps chains it cannot prove equivalent", () => {
    // A flag's value differs: whether --filter unions or overrides belongs to the runner.
    expect(gluedCheckCommand("npx vitest run --filter A && npx vitest run --filter B")).toBeNull();
    // Different commands do not glue.
    expect(gluedCheckCommand("npx vitest run a.test.ts && npx tsc --noEmit")).toBeNull();
    // Pipes, || and redirects keep the chain as written.
    expect(gluedCheckCommand("npm test || npm run test:ci")).toBeNull();
    expect(gluedCheckCommand("npm test | tail -5")).toBeNull();
    expect(gluedCheckCommand("npm test > out.log && cat out.log")).toBeNull();
    // Unequal shapes and adjacent diffs stay.
    expect(gluedCheckCommand("vitest run a.test.ts && vitest run a.test.ts b.test.ts")).toBeNull();
    // A single command is not a chain.
    expect(gluedCheckCommand("npx vitest run a.test.ts")).toBeNull();
  });
});

describe("glueReplayCommands", () => {
  const cmd = (command: string, timeoutSec = 90) => ({ command, cwd: "/w", timeoutSec });
  it("glues each command, then drops exact repeats of one (command, cwd) keeping the longest timeout", () => {
    const out = glueReplayCommands([cmd("npm test", 60), cmd("npm test", 120), cmd("npx vitest run a.test.ts && npx vitest run b.test.ts"), cmd("npx tsc --noEmit")]);
    expect(out).toEqual([{ command: "npm test", cwd: "/w", timeoutSec: 120 }, { command: "npx vitest run a.test.ts b.test.ts", cwd: "/w", timeoutSec: 90 }, { command: "npx tsc --noEmit", cwd: "/w", timeoutSec: 90 }]);
  });
  it("keeps the same command in different folders and different commands in one folder", () => {
    const out = glueReplayCommands([{ command: "npm test", cwd: "/a", timeoutSec: 10 }, { command: "npm test", cwd: "/b", timeoutSec: 10 }, { command: "npm run lint", cwd: "/a", timeoutSec: 10 }]);
    expect(out).toHaveLength(3);
  });
});

describe("contract lint runner_chain warning", () => {
  const root = "/tmp/writer";
  const task: TaskV2 = {
    schema_version: 2, display_title: "T", kind: "feature", area: "a", id: "t", title: "T", risk: "low", lane: "writer", project_cwd: root,
    read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: [],
    owns_paths: ["src/"], never_touch: [], depends_on: [], objective: "o", acceptance: ["d"], verify: "tests",
    verification: [{ command: "npx vitest run a.test.ts && npx vitest run b.test.ts", cwd: root }],
  };
  const lint = (input: Partial<LintInput> = {}) => lintContract({ task, workspacePath: root, hostId: "h", kinds: null, sandboxUnsafe: [], openTasks: [], deadDependencies: [], ...input });
  it("warns and suggests the glued command when there is no gate", () => {
    const { errors, warnings } = lint();
    expect(errors.map((e) => e.code)).not.toContain("repeated_runner_chain");
    const [warn] = warnings.filter((w) => w.code === "runner_chain");
    expect(warn?.data?.["suggestedCommand"]).toBe("npx vitest run a.test.ts b.test.ts");
    expect(warn?.message).toContain("npx vitest run a.test.ts b.test.ts");
  });
  it("warns without a suggestion when the chain cannot be glued, and stays quiet on single runs", () => {
    expect(lint().warnings.filter((w) => w.code === "runner_chain")).toHaveLength(1);
    const unglued = lintContract({ task: { ...task, verification: [{ command: "python3 t.py --filter A && python3 t.py --filter B", cwd: root }] },
      workspacePath: root, hostId: "h", kinds: null, sandboxUnsafe: [], openTasks: [], deadDependencies: [] });
    const [w2] = unglued.warnings.filter((w) => w.code === "runner_chain");
    expect(w2?.data?.["suggestedCommand"]).toBeUndefined();
    const single = lintContract({ task: { ...task, verification: [{ command: "npx vitest run a.test.ts", cwd: root }] },
      workspacePath: root, hostId: "h", kinds: null, sandboxUnsafe: [], openTasks: [], deadDependencies: [] });
    expect(single.warnings.filter((w) => w.code === "runner_chain")).toEqual([]);
  });
});
