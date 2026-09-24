import { describe, expect, it } from "vitest";
import { findUnownedChanges, resolveRunOwnershipScope, validateOwnershipContract } from "../../src/verification/ownership";

const task = {
  project_cwd:"/work/project",
  owns_paths:["src/**", "README.md"],
  never_touch:["src/secrets/**", ".git/**"],
  verification:[{ cwd:"/work/project" }, { cwd:"/work/project/src" }],
};

describe("task ownership and workspace boundaries", () => {
  it("accepts only changed paths owned by the task and outside never_touch", () => {
    expect(findUnownedChanges(["src/index.ts", "README.md"], task)).toEqual([]);
    expect(findUnownedChanges(["src/secrets/key.txt", ".git/config", "package.json"], task))
      .toEqual([".git/config", "package.json", "src/secrets/key.txt"]);
  });

  it("rejects traversal, absolute ownership patterns and verification outside workspace", () => {
    expect(validateOwnershipContract({ ...task, owns_paths:["../escape"] })).toContain("unsafe ownership path");
    expect(validateOwnershipContract({ ...task, verification:[{ cwd:"/work/other" }] })).toContain("verification cwd escapes");
  });

  it("fails closed on absolute, parent traversal and backslash changed paths", () => {
    expect(findUnownedChanges(["/etc/passwd", "../escape", "src\\secret"], task))
      .toEqual(["../escape", "/etc/passwd", "src\\secret"]);
  });

  it("uses the validated union for sibling tasks sharing a run workspace", () => {
    const result = resolveRunOwnershipScope([
      { id:"task-a", ...task, owns_paths:["src/**"], never_touch:[".git/**"] },
      { id:"task-b", ...task, owns_paths:["docs/**"], never_touch:["docs/private/**"] },
    ], "task-a", task.project_cwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskIds).toEqual(["task-a", "task-b"]);
    expect(findUnownedChanges(["docs/readme.md"], result.task)).toEqual([]);
    expect(findUnownedChanges(["docs/private/secret.md"], result.task)).toEqual(["docs/private/secret.md"]);
  });

  it.each([
    { label:"missing requested id", tasks:[{ id:"sibling", ...task }], requested:"missing", cwd:task.project_cwd, reason:"not part of the run" },
    { label:"duplicate id", tasks:[{ id:"same", ...task }, { id:"same", ...task }], requested:"same", cwd:task.project_cwd, reason:"duplicate task id" },
    { label:"foreign cwd", tasks:[{ id:"task-a", ...task }, { id:"task-b", ...task, project_cwd:"/other" }], requested:"task-a", cwd:task.project_cwd, reason:"does not match workspace" },
    { label:"empty sibling owns", tasks:[{ id:"task-a", ...task }, { id:"task-b", ...task, owns_paths:[] }], requested:"task-a", cwd:task.project_cwd, reason:"owns_paths must contain" },
  ])("rejects invalid run scope: $label", ({ tasks, requested, cwd, reason }) => {
    const result = resolveRunOwnershipScope(tasks, requested, cwd);
    expect(result).toMatchObject({ ok:false });
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});
