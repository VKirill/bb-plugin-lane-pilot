import { describe, expect, it } from "vitest";
import { validateTaskV2 } from "../src/rooms/tasks/task-v2";

const base = {
  schema_version: 2, id: "T-1", title: "Add a check", risk: "low", lane: "server", project_cwd: "/tmp/project",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/a.ts"], owns_paths: ["src/a.ts"],
  never_touch: [], depends_on: [], objective: "Add a check", acceptance: ["the check exists"], verify: "tests", verification: [],
};

describe("task-v2 skill hints", () => {
  it("accepts up to eight PM skill hints and keeps them on the task", () => {
    const skills = Array.from({ length: 8 }, (_, index) => `skill-${index}`);
    const result = validateTaskV2({ ...base, skills });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task.skills).toEqual(skills);
  });

  it("refuses more than eight skill hints", () => {
    const result = validateTaskV2({ ...base, skills: Array.from({ length: 9 }, (_, index) => `skill-${index}`) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("skills");
  });

  it("refuses an empty skill name", () => {
    const result = validateTaskV2({ ...base, skills: ["   "] });
    expect(result.ok).toBe(false);
  });

  it("leaves a task without skills as it was", () => {
    const result = validateTaskV2(base);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task.skills).toBeUndefined();
  });

  it("still refuses an unknown key", () => {
    const result = validateTaskV2({ ...base, bogus: true });
    expect(result.ok).toBe(false);
  });
});

describe("task-v2 task standard (display_title, kind)", () => {
  it("keeps both on the task, and a stored contract without them still parses", () => {
    const result = validateTaskV2({ ...base, display_title: "Страница заказов", kind: "feature", area: "page:/orders" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task).toMatchObject({ display_title: "Страница заказов", kind: "feature" });
    const old = validateTaskV2(base);
    expect(old.ok).toBe(true);
    if (old.ok) expect(old.task.display_title).toBeUndefined();
  });

  it("refuses a kind outside the seven, and leaves the length of the title to the contract lint", () => {
    expect(validateTaskV2({ ...base, kind: "bug" }).ok).toBe(false);
    for (const kind of ["feature", "fix", "check", "docs", "refactor", "research", "chore"]) expect(validateTaskV2({ ...base, kind }).ok).toBe(true);
    expect(validateTaskV2({ ...base, display_title: "я".repeat(80) }).ok).toBe(true);
  });
});

describe("task-v2 reserved repository selectors", () => {
  it("rejects repo: in write paths and raw verification cwd before normalization", () => {
    const result = validateTaskV2({
      ...base,
      expected_outputs: ["the marker is updated"],
      owns_paths: ["repo:packages/shared/marker.txt"],
      verification: [{ command: "true", cwd: "repo:." }],
      repo_scope: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining("owns_paths"),
        expect.stringContaining("verification[0].cwd"),
      ]));
      expect(result.errors.join(" ")).toContain("repo:");
    }
  });

  it("keeps read selectors legal without banning ordinary POSIX colons", () => {
    const result = validateTaskV2({
      ...base,
      read_first: ["repo:docs/guide.md"],
      expected_outputs: ["notes/marker:latest.txt"],
      owns_paths: ["notes/marker:latest.txt"],
      verification: [{ command: "true", cwd: "." }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.read_first).toEqual(["repo:docs/guide.md"]);
      expect(result.task.owns_paths).toEqual(["notes/marker:latest.txt"]);
    }
  });
});
