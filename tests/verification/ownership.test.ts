import { describe, expect, it } from "vitest";
import { findUnownedChanges, validateOwnershipContract } from "../../src/verification/ownership";

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
});
