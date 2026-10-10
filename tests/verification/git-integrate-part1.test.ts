import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { integrateWorktree, prepareWorktree, withBaseLock } from "../../src/rooms/verification/git-integrate";
import { gitOwnershipChangedPaths } from "../../src/rooms/verification/git-ownership";
import { git, repo } from "./git-integrate-helpers";

// These tests build real repositories and worktrees; inside Lane Pilot's sandboxed check the whole suite runs
// about 2.5x slower and vitest's 5 s default cut them off (2026-10-06 log: 12 uniform 5000 ms timeouts).
vi.setConfig({ testTimeout: 120_000 });

it("commits a writer worktree and merges it into main, once", async () => {
  const { base, worktree } = await repo();
  const a = await worktree("a");
  await writeFile(join(a, "lib.ts"), "export const x = 1;\n");
  const merged = await integrateWorktree({ basePath: base, worktreePath: a, message: "task a" });
  expect(merged.status).toBe("merged");
  expect(await readFile(join(base, "lib.ts"), "utf8")).toBe("export const x = 1;\n");
  expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "task a" })).status).toBe("up-to-date");
});

it("merges two writers' edits to one file and reports a real conflict without touching main", async () => {
  const { base, worktree } = await repo();
  const a = await worktree("a"), b = await worktree("b"), c = await worktree("c");
  await writeFile(join(a, "server.ts"), "line1 from a\nline2\nline3\n");
  await writeFile(join(b, "server.ts"), "line1\nline2\nline3 from b\n");
  await writeFile(join(c, "server.ts"), "line1 from c\nline2\nline3\n");
  expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "a" })).status).toBe("merged");
  expect((await integrateWorktree({ basePath: base, worktreePath: b, message: "b" })).status).toBe("merged");
  expect(await readFile(join(base, "server.ts"), "utf8")).toBe("line1 from a\nline2\nline3 from b\n");
  const conflict = await integrateWorktree({ basePath: base, worktreePath: c, message: "c" });
  expect(conflict.status).toBe("conflict");
  expect(conflict.conflicts).toEqual(["server.ts"]);
  expect(await readFile(join(base, "server.ts"), "utf8")).toBe("line1 from a\nline2\nline3 from b\n");
  expect(git(base, "status", "--porcelain").trim()).toBe("");
});

it("links the base node_modules into a writer worktree and keeps the link out of commits", async () => {
  const { prepareWorktree } = await import("../../src/rooms/verification/git-integrate");
  const { mkdir } = await import("node:fs/promises");
  const { base, worktree } = await repo();
  await mkdir(join(base, "node_modules", "vitest"), { recursive: true });
  const a = await worktree("a");
  expect(await prepareWorktree({ basePath: base, worktreePath: a })).toEqual({ linked: ["node_modules"] });
  expect(git(a, "status", "--porcelain").trim()).toBe("");
  await writeFile(join(a, "x.ts"), "x\n");
  expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "a" })).status).toBe("merged");
  expect(git(base, "show", "--stat", "--format=", "HEAD^2")).not.toContain("node_modules");
});

it("gives tool caches in node_modules their own folder so checks never write into the base checkout", async () => {
  const { prepareWorktree } = await import("../../src/rooms/verification/git-integrate");
  const { mkdir, lstat } = await import("node:fs/promises");
  const { base, worktree } = await repo();
  await mkdir(join(base, "node_modules", "vitest"), { recursive: true });
  await mkdir(join(base, "node_modules", ".vite-temp"), { recursive: true });
  await mkdir(join(base, "node_modules", ".bin"), { recursive: true });
  const a = await worktree("cache");
  await prepareWorktree({ basePath: base, worktreePath: a });
  expect((await lstat(join(a, "node_modules", ".vite-temp"))).isSymbolicLink()).toBe(false);
  expect((await lstat(join(a, "node_modules", ".bin"))).isSymbolicLink()).toBe(true);
  await writeFile(join(a, "node_modules", ".vite-temp", "config.mjs"), "x");
  await expect(lstat(join(base, "node_modules", ".vite-temp", "config.mjs"))).rejects.toThrow();
});

it("installs dependencies from the lockfile before the first writer so nobody runs npm install", async () => {
  const { prepareWorktree } = await import("../../src/rooms/verification/git-integrate");
  const { base, worktree } = await repo();
  const { mkdir, rm } = await import("node:fs/promises");
  await mkdir(join(base, "dep"));
  await writeFile(join(base, "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }) + "\n");
  await writeFile(join(base, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", dependencies: { dep: "file:./dep" } }) + "\n");
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: base, stdio: "pipe" });
  await rm(join(base, "node_modules"), { recursive: true, force: true });
  const lock = await readFile(join(base, "package-lock.json"), "utf8");
  git(base, "add", "."); git(base, "commit", "-qm", "deps");
  const a = await worktree("a");
  expect(await prepareWorktree({ basePath: base, worktreePath: a })).toEqual({ linked: ["node_modules"] });
  expect(await readFile(join(base, "package-lock.json"), "utf8")).toBe(lock);
}, 120_000);
