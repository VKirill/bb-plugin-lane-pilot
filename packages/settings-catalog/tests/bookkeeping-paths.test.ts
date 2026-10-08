import { expect, it } from "vitest";
import { BOOKKEEPING_PATHS, bookkeepingSetting, filterOwnershipNoise, isBookkeepingPath, isOwnershipNoise } from "@lane-pilot/settings-catalog";

it("names the bookkeeping the harness, hooks and sibling agents write", () => {
  for (const path of [".agents/PROGRESS.md", ".agents/CHANGELOG.md", ".agents/memory/episodes/a/b.json", ".agents/runs/lprun_1/x", ".agents/reports/r.md", ".bb/chats/thr_1/n.md", "notes/lock/w.lock"]) {
    expect(isBookkeepingPath(path), path).toBe(true);
  }
  expect(BOOKKEEPING_PATHS).toContain("notes/lock/**");
});

it("is not fooled by a real file with a similar name", () => {
  for (const path of ["src/notes/lock.ts", "notes/lockfile.md", ".agents/plans/items/t1/PLAN.md", "docs/.agents/PROGRESS.md", "AGENTS.md"]) {
    expect(isBookkeepingPath(path), path).toBe(false);
  }
});

it("adds the project's patterns to the list", () => {
  expect(isBookkeepingPath("tmp/x.log")).toBe(false);
  expect(isBookkeepingPath("tmp/x.log", ["tmp/**"])).toBe(true);
  expect(isBookkeepingPath("var/out.json", ["var/*.json"])).toBe(true);
});

it("reads the setting as an array or as a text of lines and commas, dropping unsafe patterns", () => {
  expect(bookkeepingSetting({})).toEqual([]);
  expect(bookkeepingSetting({ "bookkeeping.paths": ["tmp/**", " ", 4, "/abs/**", "../up/**", "tmp/**"] })).toEqual(["tmp/**"]);
  expect(bookkeepingSetting({ "bookkeeping.paths": "tmp/**\nvar/*.json, out/" })).toEqual(["tmp/**", "var/*.json", "out/"]);
});

it("filters the ownership noise: bookkeeping, agent folders, tool caches, and the project's own", () => {
  const paths = ["src/a.ts", "notes/lock/w.lock", ".agents/plans/items/t/PLAN.md", "AGENTS.md", "pkg/.vite/x.json", "tmp/x.log", "lib/b.ts"];
  expect(filterOwnershipNoise(paths)).toEqual(["lib/b.ts", "src/a.ts", "tmp/x.log"]);
  expect(filterOwnershipNoise(paths, ["tmp/**"])).toEqual(["lib/b.ts", "src/a.ts"]);
  expect(isOwnershipNoise("AGENTS.md")).toBe(true);
});
