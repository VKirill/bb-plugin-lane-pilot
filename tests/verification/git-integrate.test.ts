import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { integrateWorktree } from "../../src/verification/git-integrate";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

async function repo() {
  const base = join(await mkdtemp(join(tmpdir(), "lp-integrate-")), "main");
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  await writeFile(join(base, "server.ts"), "line1\nline2\nline3\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");
  const worktree = async (name: string) => {
    const path = join(base, "..", name);
    git(base, "worktree", "add", "-q", "-b", `bb/${name}`, path, "main");
    return path;
  };
  return { base, worktree };
}

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
  const { prepareWorktree } = await import("../../src/verification/git-integrate");
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

it("installs dependencies from the lockfile before the first writer so nobody runs npm install", async () => {
  const { prepareWorktree } = await import("../../src/verification/git-integrate");
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

it("creates Lane Pilot's own worktree of a section repo and removes it once merged", async () => {
  const { createWorktree } = await import("../../src/verification/git-integrate");
  const { stat } = await import("node:fs/promises");
  const { base } = await repo();
  const target = join(base, "..", "own", "main");
  const created = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_1" });
  expect(created).toMatchObject({ status: "ready", path: target, branch: "lane/lpattempt_1" });
  await writeFile(join(target, "feature.ts"), "export {};\n");
  expect((await integrateWorktree({ basePath: base, worktreePath: target, message: "t", removeWorktree: true })).status).toBe("merged");
  expect(await stat(target).catch(() => null)).toBeNull();
  expect(git(base, "branch", "--list", "lane/*").trim()).toBe("");
  expect(await readFile(join(base, "feature.ts"), "utf8")).toBe("export {};\n");
});

it("removes only Lane Pilot's own worktree of a failed attempt", async () => {
  const { createWorktree, removeLaneWorktree } = await import("../../src/verification/git-integrate");
  const { stat } = await import("node:fs/promises");
  const { base, worktree } = await repo();
  const own = join(base, "..", "own2", "main");
  await createWorktree({ basePath: base, targetPath: own, name: "lpattempt_2" });
  expect(await removeLaneWorktree({ basePath: base, worktreePath: own })).toEqual({ removed: true });
  expect(await stat(own).catch(() => null)).toBeNull();
  const foreign = await worktree("bb-owned");
  expect(await removeLaneWorktree({ basePath: base, worktreePath: foreign })).toEqual({ removed: false });
});
