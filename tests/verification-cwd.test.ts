import { describe, expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { mapVerificationCwd, retargetTask } from "../src/rooms/tasks/verification-cwd";
import { validateTaskV2 } from "../src/rooms/tasks/task-v2";
import { lintContract } from "../src/rooms/tasks/server/contract-lint";
import { freshAttemptStart } from "../src/rooms/writer/server/start";

/**
 * Live 2026-10-09 (SelfyStudio): `fix-marketing-greeting-cards-tests` had `npx vitest run tests/fitness/ ...` with cwd
 * /home/ubuntu/apps/selfystudio/apps/marketing. Every place that moved the task into an attempt's worktree set each check's cwd
 * to the worktree root, so the validator ran it from the repo root (ENOENT) and the writer was blocked three times.
 */
const PROJECT = "/home/ubuntu/apps/selfystudio";
const WORKTREE = "/home/ubuntu/.bb/worktrees/attempt-1";

const task = (verification: TaskV2["verification"]): TaskV2 => ({
  schema_version: 2, id: "fix-marketing", title: "Fix", risk: "low", lane: "writer", project_cwd: PROJECT,
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["apps/marketing/tests/fitness/a.test.ts"],
  owns_paths: ["apps/marketing/tests/"], never_touch: [], depends_on: [], objective: "Fix the tests", acceptance: ["the tests pass"],
  verify: "tests", verification,
});

describe("mapVerificationCwd", () => {
  it("keeps an absolute cwd inside the project at the same relative path in the worktree", () => {
    expect(mapVerificationCwd(`${PROJECT}/apps/marketing`, PROJECT, WORKTREE)).toBe(`${WORKTREE}/apps/marketing`);
    expect(mapVerificationCwd(PROJECT, PROJECT, WORKTREE)).toBe(WORKTREE);
    expect(mapVerificationCwd(`${PROJECT}/`, PROJECT, WORKTREE)).toBe(WORKTREE);
  });

  it("reads a relative cwd against the workspace", () => {
    expect(mapVerificationCwd("apps/marketing", PROJECT, WORKTREE)).toBe(`${WORKTREE}/apps/marketing`);
    expect(mapVerificationCwd(".", PROJECT, WORKTREE)).toBe(WORKTREE);
  });

  it("refuses a cwd outside the project, also a sibling that only shares the prefix", () => {
    expect(mapVerificationCwd("/etc", PROJECT, WORKTREE)).toBeNull();
    expect(mapVerificationCwd(`${PROJECT}-other/apps`, PROJECT, WORKTREE)).toBeNull();
    expect(mapVerificationCwd("../elsewhere", PROJECT, WORKTREE)).toBeNull();
    expect(mapVerificationCwd(`${PROJECT}/apps/../../x`, PROJECT, WORKTREE)).toBeNull();
  });
});

describe("a task moved into an attempt's workspace keeps each check's folder", () => {
  const checks = [{ command: "npx vitest run tests/fitness/", cwd: `${PROJECT}/apps/marketing` }, { command: "npm run typecheck", cwd: PROJECT }];

  it("retargetTask", () => {
    const moved = retargetTask(task(checks), WORKTREE);
    expect(moved.project_cwd).toBe(WORKTREE);
    expect(moved.verification.map((check) => check.cwd)).toEqual([`${WORKTREE}/apps/marketing`, WORKTREE]);
  });

  it("a fresh attempt on the run's workspace (writer start)", () => {
    const start = freshAttemptStart(task(checks), { writerWorkspacePath: PROJECT } as PrototypeConfig, WORKTREE);
    expect(start.task.verification.map((check) => check.cwd)).toEqual([`${WORKTREE}/apps/marketing`, WORKTREE]);
  });

  it("moved back to main for the post-merge check, the folder is the same", () => {
    const inWorktree = retargetTask(task(checks), WORKTREE);
    expect(retargetTask(inWorktree, PROJECT).verification.map((check) => check.cwd)).toEqual([`${PROJECT}/apps/marketing`, PROJECT]);
  });
});

describe("task-v2 verification cwd", () => {
  it("accepts a relative cwd and reads it against project_cwd", () => {
    const valid = validateTaskV2(task([{ command: "npx vitest run", cwd: "apps/marketing" }]));
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.task.verification[0]!.cwd).toBe(`${PROJECT}/apps/marketing`);
  });

  it("lint refuses a cwd outside the project with a message that says what to do", () => {
    const outside = lintContract({ task: task([{ command: "npx vitest run", cwd: "/home/ubuntu/other-project" }]), workspacePath: PROJECT, hostId: "h", kinds: null, sandboxUnsafe: [], gate: null, openTasks: [], deadDependencies: [] } as never);
    const finding = outside.errors.find((error) => error.code === "verification_cwd");
    expect(finding?.message).toContain("/home/ubuntu/other-project");
    expect(finding?.message).toContain(PROJECT);
    const inside = lintContract({ task: task([{ command: "npx vitest run", cwd: `${PROJECT}/apps/marketing` }]), workspacePath: PROJECT, hostId: "h", kinds: null, sandboxUnsafe: [], gate: null, openTasks: [], deadDependencies: [] } as never);
    expect(inside.errors.find((error) => error.code === "verification_cwd")).toBeUndefined();
  });
});
