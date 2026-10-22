import { describe, expect, it } from "vitest";
import { validateTaskV2 } from "../src/rooms/tasks/task-v2";
import { rerootTask } from "../src/rooms/tasks/task-base";
import { classifyWriterOutput } from "../src/rooms/tasks/validate-output";
import { TRUSTED_TOOLING_PATTERNS, applyTrustedTooling, verificationScriptPaths } from "../src/rooms/tasks/trusted-tooling";
import { findUnownedChanges } from "../src/rooms/verification/ownership";

const base = {
  schema_version: 2, id: "T-1", title: "Add a check", risk: "low", lane: "server", project_cwd: "/tmp/project",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/a.ts"], owns_paths: ["src/a.ts"],
  never_touch: [], depends_on: [], objective: "Add a check", acceptance: ["the check exists"], verify: "tests", verification: [],
};
const taskOf = (extra: Record<string, unknown> = {}) => {
  const valid = validateTaskV2({ ...base, ...extra });
  if (!valid.ok) throw new Error(valid.errors.join("; "));
  return valid.task;
};

describe("trusted tooling in never_touch (P2-4)", () => {
  it("adds the default patterns to every task, after the PM's own entries, once", () => {
    const task = taskOf({ never_touch: ["docs/**"] });
    expect(task.never_touch).toEqual(["docs/**", ...TRUSTED_TOOLING_PATTERNS]);
    expect(applyTrustedTooling(task).never_touch).toEqual(task.never_touch);
  });

  it("is lifted by an owns_paths line that names the tooling, and only for that tooling", () => {
    const task = taskOf({ owns_paths: ["src/a.ts", ".github/workflows/ci.yml"] });
    expect(task.never_touch).not.toContain(".github/workflows/**");
    expect(task.never_touch).toContain(".claude/**");
    expect(task.never_touch).toContain(".husky/**");
  });

  it("is lifted by expected_outputs that name it, and by a path inside it", () => {
    expect(taskOf({ owns_paths: [".claude/skills/x/SKILL.md"], expected_outputs: [".claude/skills/x/SKILL.md"] }).never_touch).not.toContain(".claude/**");
    expect(taskOf({ owns_paths: ["src/a.ts", "lane-stack/hooks/pre.sh"], expected_outputs: ["ok"] }).never_touch).not.toContain("lane-stack/hooks/**");
  });

  it("is not lifted by a catch-all owns_paths", () => {
    for (const owns of [["**"], ["*"], ["**/*.ts"], ["."]]) {
      const task = taskOf({ owns_paths: owns, expected_outputs: ["ok"] });
      expect(task.never_touch).toEqual([...TRUSTED_TOOLING_PATTERNS]);
    }
  });

  it("adds the check scripts the verification commands run, not the tests they run", () => {
    const task = taskOf({
      owns_paths: ["src/a.ts", "tests/a.test.ts"],
      verification: [
        { command: "bash scripts/check.sh && npx vitest run tests/a.test.ts", cwd: "/tmp/project" },
        { command: "FOO=1 node tools/verify.mjs --strict", cwd: "/tmp/project" },
        { command: "./bin/gate.sh", cwd: "/tmp/project/apps/web" },
      ],
    });
    expect(task.never_touch).toEqual(expect.arrayContaining(["scripts/check.sh", "tools/verify.mjs", "apps/web/bin/gate.sh"]));
    expect(task.never_touch).not.toContain("tests/a.test.ts");
  });

  it("does not guess at commands that run no script file of the project", () => {
    const paths = verificationScriptPaths({ project_cwd: "/tmp/project", verification: [
      { command: "npm test", cwd: "/tmp/project" },
      { command: "node ../../elsewhere.js", cwd: "/tmp/project" },
      { command: "node --test tests/x.test.js", cwd: "/tmp/project" },
      { command: "grep -q ok out.txt", cwd: "/tmp/project" },
    ] });
    expect(paths).toEqual([]);
  });

  it("leaves a check script the task owns to the task", () => {
    const task = taskOf({ owns_paths: ["src/a.ts", "scripts/check.sh"], verification: [{ command: "bash scripts/check.sh", cwd: "/tmp/project" }] });
    expect(task.never_touch).not.toContain("scripts/check.sh");
  });

  it("makes the ownership check refuse a hook edit and say what to do", () => {
    const task = taskOf({ owns_paths: ["src/**"], expected_outputs: ["ok"], verification: [{ command: "bash scripts/check.sh", cwd: "/tmp/project" }] });
    expect(findUnownedChanges([".husky/pre-commit", "scripts/check.sh", "src/a.ts"], task)).toEqual([".husky/pre-commit", "scripts/check.sh"]);
    const verdict = classifyWriterOutput({ task: { ...task, owns_paths: ["src/**", "scripts/**"] }, produced: ["scripts/check.sh", "src/a.ts"], contents: {} });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("never_touch matched scripts/check.sh");
      expect(verdict.reason).toContain("trusted tooling");
      expect(verdict.reason).toContain("owns_paths");
    }
  });

  it("does not call an ordinary stray file trusted tooling", () => {
    const task = taskOf();
    const verdict = classifyWriterOutput({ task, produced: ["src/a.ts", "src/other.ts"], contents: { "src/a.ts": "x" } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).not.toContain("trusted tooling");
  });

  it("is added again relative to the repository a task moves into", () => {
    const task = taskOf({ project_cwd: "/tmp/project", owns_paths: ["plugins/x/src/a.ts"], expected_outputs: ["plugins/x/src/a.ts"], never_touch: [".github/**", "plugins/x/docs/**"] });
    const moved = rerootTask(task, "plugins/x");
    expect(moved?.task.owns_paths).toEqual(["src/a.ts"]);
    expect(moved?.task.never_touch).toEqual(["docs/**", ...TRUSTED_TOOLING_PATTERNS]);
  });
});
