import { describe, expect, it } from "vitest";
import { findUnownedChanges, findUnownedRunChanges, resolveRunOwnershipScope, validateOwnershipContract } from "../../src/rooms/verification/ownership";

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

  it("does not count the owns-check receipt check-owns-paths writes as a writer change", () => {
    expect(findUnownedChanges([".agents/runs/r1/artifacts/001/owns-check.json", "src/index.ts"], task)).toEqual([]);
    expect(findUnownedChanges([".agents/runs/r1/artifacts/001/outcome.json", ".agents/runs/r1/tasks/001.yaml"], task))
      .toEqual([".agents/runs/r1/artifacts/001/outcome.json", ".agents/runs/r1/tasks/001.yaml"]);
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

  it("lets a sibling's never_touch veto only the sibling, never the owner of a path", () => {
    // The PM lists everything a task must not touch, which is exactly what its siblings own.
    const result = resolveRunOwnershipScope([
      { id:"api", ...task, owns_paths:["apps/api/**"], never_touch:["apps/marketing/**", "packages/**"] },
      { id:"ui", ...task, owns_paths:["apps/marketing/app/**"], never_touch:["apps/api/**", "packages/**"] },
    ], "api", task.project_cwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findUnownedRunChanges(["apps/api/src/route.ts", "apps/marketing/app/Page.vue"], result.tasks)).toEqual([]);
    expect(findUnownedRunChanges(["packages/contracts/index.ts", "apps/marketing/server/x.ts"], result.tasks))
      .toEqual(["apps/marketing/server/x.ts", "packages/contracts/index.ts"]);
    expect(findUnownedRunChanges(["apps/api/src/route.ts"], [])).toEqual(["apps/api/src/route.ts"]);
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

describe("directory paths with a trailing slash", () => {
  it("own and guard everything under them, as in owns-paths", async () => {
    const { findUnownedChanges } = await import("../../src/rooms/verification/ownership");
    const task = {
      project_cwd: "/repo",
      owns_paths: ["apps/bot-thin/src/handlers/import-preset.ts", "apps/bot-thin/src/handlers/__tests__/", "apps/marketing/i18n/locales/"],
      never_touch: ["apps/api/", "docs/"],
      verification: [],
    } as never;
    expect(findUnownedChanges([
      "apps/bot-thin/src/handlers/__tests__/import-preset.test.ts",
      "apps/marketing/i18n/locales/ru.json",
      "apps/bot-thin/src/handlers/import-preset.ts",
    ], task)).toEqual([]);
    // Never_touch folders now guard their files too, and a sibling prefix is not the folder.
    expect(findUnownedChanges(["docs/index.md", "apps/api/server.ts", "apps/bot-thin/src/handlers/__tests__x/a.ts"], task))
      .toEqual(["apps/api/server.ts", "apps/bot-thin/src/handlers/__tests__x/a.ts", "docs/index.md"]);
  });
});
