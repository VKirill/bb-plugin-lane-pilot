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

it("re-points workspace package links at the worktree so checks import the writer's edits", async () => {
  const { prepareWorktree } = await import("../../src/verification/git-integrate");
  const { mkdir, lstat, readlink, realpath } = await import("node:fs/promises");
  const { base, worktree } = await repo();
  await writeFile(join(base, "package.json"), JSON.stringify({ name: "mono", workspaces: ["packages/*", "apps/api"] }) + "\n");
  await mkdir(join(base, "packages", "contracts"), { recursive: true });
  await writeFile(join(base, "packages", "contracts", "package.json"), JSON.stringify({ name: "@mono/contracts" }) + "\n");
  await writeFile(join(base, "packages", "contracts", "index.js"), "module.exports = 'base';\n");
  await mkdir(join(base, "apps", "api"), { recursive: true });
  await writeFile(join(base, "apps", "api", "package.json"), JSON.stringify({ name: "@mono/api" }) + "\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "mono");
  // npm's layout: third-party packages, workspace links back into the repo, a nested node_modules in one app.
  await mkdir(join(base, "node_modules", "vitest"), { recursive: true });
  await writeFile(join(base, "node_modules", ".package-lock.json"), "{}\n");
  await mkdir(join(base, "node_modules", "@mono"));
  await mkdir(join(base, "node_modules", ".bin"));
  const { symlink } = await import("node:fs/promises");
  await symlink("../../packages/contracts", join(base, "node_modules", "@mono", "contracts"), "dir");
  await symlink("../../apps/api", join(base, "node_modules", "@mono", "api"), "dir");
  await mkdir(join(base, "apps", "api", "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(base, ".gitignore"), "node_modules\ndist\n");
  git(base, "add", ".gitignore"); git(base, "commit", "-qm", "ignore");
  await mkdir(join(base, "packages", "contracts", "dist"));
  await writeFile(join(base, "packages", "contracts", "dist", "index.d.ts"), "export {};\n");
  const a = await worktree("a");
  expect(await prepareWorktree({ basePath: base, worktreePath: a })).toEqual({ linked: ["node_modules", "apps/api/node_modules", "packages/contracts/dist"] });
  expect((await lstat(join(a, "packages", "contracts", "dist"))).isSymbolicLink()).toBe(false);
  expect(await readFile(join(a, "packages", "contracts", "dist", "index.d.ts"), "utf8")).toBe("export {};\n");
  expect(await realpath(join(a, "node_modules", "vitest"))).toBe(await realpath(join(base, "node_modules", "vitest")));
  expect(await realpath(join(a, "node_modules", "@mono", "contracts"))).toBe(await realpath(join(a, "packages", "contracts")));
  expect(await readlink(join(a, "node_modules", ".package-lock.json"))).toBe(join(await realpath(base), "node_modules", ".package-lock.json"));
  expect(await realpath(join(a, "apps", "api", "node_modules", "left-pad"))).toBe(await realpath(join(base, "apps", "api", "node_modules", "left-pad")));
  await writeFile(join(a, "packages", "contracts", "index.js"), "module.exports = 'worktree';\n");
  const { execFileSync: run } = await import("node:child_process");
  expect(run("node", ["-e", "console.log(require('@mono/contracts'))"], { cwd: join(a, "apps", "api"), encoding: "utf8" }).trim()).toBe("worktree");
  expect(git(a, "status", "--porcelain").trim()).toBe("M packages/contracts/index.js");
  expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "a" })).status).toBe("merged");
  expect(git(base, "show", "--stat", "--format=", "HEAD^2")).not.toContain("node_modules");
});

it("names the files when main has uncommitted edits the merge would overwrite", async () => {
  const { base, worktree } = await repo();
  const a = await worktree("a");
  await writeFile(join(a, "server.ts"), "line1 from a\nline2\nline3\n");
  await writeFile(join(base, "server.ts"), "line1\nline2 edited in main\nline3\n");
  const blocked = await integrateWorktree({ basePath: base, worktreePath: a, message: "a" });
  expect(blocked).toMatchObject({ status: "conflict", conflicts: ["server.ts"] });
  expect(blocked.reason).toContain("base checkout has uncommitted changes");
  expect(await readFile(join(base, "server.ts"), "utf8")).toBe("line1\nline2 edited in main\nline3\n");
});

it("runs the project's pre-commit hook on writer work: a rejection fails the attempt with the hook output", async () => {
  const { chmod } = await import("node:fs/promises");
  const { base, worktree } = await repo();
  const hook = join(base, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nif git diff --cached | grep -q FORBIDDEN; then echo 'lint: FORBIDDEN marker in staged code' >&2; exit 1; fi\n");
  await chmod(hook, 0o755);
  const bad = await worktree("bad");
  await writeFile(join(bad, "lib.ts"), "export const x = 'FORBIDDEN';\n");
  const rejected = await integrateWorktree({ basePath: base, worktreePath: bad, message: "bad" });
  expect(rejected.status).toBe("failed");
  expect(rejected.reason).toContain("lint: FORBIDDEN marker in staged code");
  expect(git(base, "log", "--oneline").trim().split("\n")).toHaveLength(1);
  const good = await worktree("good");
  await writeFile(join(good, "lib.ts"), "export const x = 1;\n");
  expect((await integrateWorktree({ basePath: base, worktreePath: good, message: "good" })).status).toBe("merged");
});
