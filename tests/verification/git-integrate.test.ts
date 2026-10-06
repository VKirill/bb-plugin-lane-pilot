import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// These tests build real repositories and worktrees; inside Lane Pilot's sandboxed check the whole suite runs
// about 2.5x slower and vitest's 5 s default cut them off (2026-10-06 log: 12 uniform 5000 ms timeouts).
vi.setConfig({ testTimeout: 120_000 });
import { integrateWorktree, prepareWorktree, withBaseLock } from "../../src/verification/git-integrate";
import { gitOwnershipChangedPaths } from "../../src/verification/git-ownership";

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

it("gives tool caches in node_modules their own folder so checks never write into the base checkout", async () => {
  const { prepareWorktree } = await import("../../src/verification/git-integrate");
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
  await writeFile(join(base, ".gitignore"), "node_modules\ndist\n.nuxt\n");
  git(base, "add", ".gitignore"); git(base, "commit", "-qm", "ignore");
  await mkdir(join(base, "packages", "contracts", "dist"));
  await writeFile(join(base, "packages", "contracts", "dist", "index.d.ts"), "export {};\n");
  await mkdir(join(base, "apps", "api", ".nuxt"));
  await writeFile(join(base, "apps", "api", ".nuxt", "tsconfig.json"), "{}\n");
  const a = await worktree("a");
  expect(await prepareWorktree({ basePath: base, worktreePath: a })).toEqual({ linked: ["node_modules", "apps/api/node_modules", "apps/api/.nuxt", "packages/contracts/dist"] });
  // A Nuxt app's generated .nuxt/ is copied like dist/, so its tests find .nuxt/tsconfig.json.
  expect(await readFile(join(a, "apps", "api", ".nuxt", "tsconfig.json"), "utf8")).toBe("{}\n");
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

it("takes over a merge lock whose process is gone, at once", async () => {
  const { base, worktree } = await repo();
  const lock = join(base, ".git", "lane-pilot-integrate.lock");
  await mkdir(lock);
  // A pid that cannot be running: the host process that took the lock was killed mid-merge.
  await writeFile(join(lock, "owner"), "999999");
  const a = await worktree("a");
  await writeFile(join(a, "lib.ts"), "x\n");
  const started = Date.now();
  expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "task a" })).status).toBe("merged");
  expect(Date.now() - started).toBeLessThan(5_000);
});

it("takes over an ownerless lock an older Lane Pilot left behind", async () => {
  const { base } = await repo();
  const lock = join(base, ".git", "lane-pilot-integrate.lock");
  await mkdir(lock);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  expect(await withBaseLock(base, () => "ran")).toBe("ran");
});

it("takes over a lock whose owner file was never written, without the 10-minute wait", async () => {
  const { base } = await repo();
  const lock = join(base, ".git", "lane-pilot-integrate.lock");
  // The host worker was stopped by a plugin reload between creating the owner file and writing its pid.
  await mkdir(lock);
  await writeFile(join(lock, "owner"), "");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  expect(await withBaseLock(base, () => "ran", "", 2_000)).toBe("ran");
});

it("sees work already committed in a writer worktree against main's current HEAD", async () => {
  const { base, worktree } = await repo();
  const a = await worktree("a");
  await writeFile(join(a, "lib.ts"), "x\n");
  git(a, "add", "-A"); git(a, "commit", "-qm", "writer work");
  // main moved on meanwhile; only the worktree's own commit counts.
  await writeFile(join(base, "other.ts"), "y\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "sibling merge");
  const head = git(base, "rev-parse", "HEAD").trim();
  const changed = await gitOwnershipChangedPaths({ projectCwd: a, baseSha: head, compareCommitted: true });
  expect(changed.paths).toEqual(["lib.ts"]);
});

it("reports a base checkout held by a live integration as busy, naming the holder, and keeps the work", async () => {
  const { base, worktree } = await repo();
  const lock = join(base, ".git", "lane-pilot-integrate.lock");
  const holder = spawn("sleep", ["30"]);
  try {
    await mkdir(lock);
    await writeFile(join(lock, "owner"), `${holder.pid}\nbot-fix: Bot fallback`);
    const a = await worktree("a");
    await writeFile(join(a, "lib.ts"), "x\n");
    const busy = await integrateWorktree({ basePath: base, worktreePath: a, message: "api-snap: Snapshot", lockWaitMs: 1_000 });
    expect(busy).toMatchObject({ status: "busy", holder: "bot-fix: Bot fallback" });
    expect(git(a, "status", "--porcelain").trim()).toBe("");
    await (await import("node:fs/promises")).rm(lock, { recursive: true });
    expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "api-snap: Snapshot" })).status).toBe("merged");
  } finally { holder.kill(); }
});

it("rebuilds in main a workspace package the merge changed", async () => {
  const { base, worktree } = await repo();
  await mkdir(join(base, "packages", "lib", "src"), { recursive: true });
  await mkdir(join(base, "packages", "lib", "dist"), { recursive: true });
  await writeFile(join(base, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }));
  await writeFile(join(base, "packages", "lib", "package.json"), JSON.stringify({ name: "lib", scripts: { build: "node -e \"require('fs').writeFileSync('dist/built.txt','yes')\"" } }));
  await writeFile(join(base, ".gitignore"), "dist/\nnode_modules/\n");
  await writeFile(join(base, "packages", "lib", "src", "a.ts"), "1\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "lib");
  const a = await worktree("a");
  await writeFile(join(a, "packages", "lib", "src", "a.ts"), "2\n");
  const merged = await integrateWorktree({ basePath: base, worktreePath: a, message: "lib change" });
  expect(merged.status).toBe("merged");
  expect(merged.rebuilt).toEqual([{ dir: "packages/lib", ok: true, detail: null }]);
  expect(await readFile(join(base, "packages", "lib", "dist", "built.txt"), "utf8")).toBe("yes");
});

it("copies Prisma's generated client into a worktree as real, writable folders; other packages stay links", async () => {
  const { base, worktree } = await repo();
  await writeFile(join(base, ".gitignore"), "node_modules/\n"); git(base, "add", "-A"); git(base, "commit", "-qm", "ignore");
  await mkdir(join(base, "node_modules", ".prisma", "client"), { recursive: true });
  await writeFile(join(base, "node_modules", ".prisma", "client", "index.js"), "generated\n");
  await mkdir(join(base, "node_modules", "@prisma", "client"), { recursive: true });
  await writeFile(join(base, "node_modules", "@prisma", "client", "index.js"), "client\n");
  await mkdir(join(base, "node_modules", "zod"), { recursive: true });
  const a = await worktree("a");
  await prepareWorktree({ basePath: base, worktreePath: a });
  const { lstat } = await import("node:fs/promises");
  expect((await lstat(join(a, "node_modules", ".prisma"))).isSymbolicLink()).toBe(false);
  expect((await lstat(join(a, "node_modules", "@prisma", "client"))).isSymbolicLink()).toBe(false);
  expect(await readFile(join(a, "node_modules", ".prisma", "client", "index.js"), "utf8")).toBe("generated\n");
  expect((await lstat(join(a, "node_modules", "zod"))).isSymbolicLink()).toBe(true);
  await writeFile(join(a, "node_modules", ".prisma", "client", "index.js"), "regenerated\n");
  expect(await readFile(join(base, "node_modules", ".prisma", "client", "index.js"), "utf8")).toBe("generated\n");
});

it("docs worktree: commits under its own lock and merges only what is committed, leaving other units' pages out", async () => {
  const { base, worktree } = await repo();
  const docs = await worktree("docs");
  await mkdir(join(docs, "docs"), { recursive: true });
  await writeFile(join(docs, "docs", "checked.md"), "# checked\n");
  await writeFile(join(docs, "docs", "unchecked.md"), "# still being written\n");
  // The lock of a worktree is in its own git dir (.git is a file there); before this the docs commit failed with ENOTDIR.
  await withBaseLock(docs, () => { git(docs, "add", "docs/checked.md"); git(docs, "commit", "-qm", "docs: checked"); });
  const merged = await integrateWorktree({ basePath: base, worktreePath: docs, message: "docs: nightly", committedOnly: true });
  expect(merged.status).toBe("merged");
  expect(await readFile(join(base, "docs", "checked.md"), "utf8")).toBe("# checked\n");
  await expect(readFile(join(base, "docs", "unchecked.md"), "utf8")).rejects.toThrow();
  expect(git(base, "status", "--porcelain")).toBe("");
});

it("saves a released worktree's uncommitted edits and unshared commits as a patch", async () => {
  const { base, worktree } = await repo();
  const { snapshotWorktree } = await import("../../src/verification/git-integrate");
  const a = await worktree("rejected");
  await writeFile(join(a, "kept.ts"), "export const committed = 1;\n");
  git(a, "add", "-A"); git(a, "commit", "-qm", "rejected commit");
  await writeFile(join(a, "server.ts"), "line1 edited\nline2\nline3\n");
  const dir = join(base, "..", "released");
  const saved = await snapshotWorktree({ worktreePath: a, name: "env_x", dir });
  expect(saved).toMatchObject({ status: "saved", dirty: 1, ahead: 1 });
  expect(await readFile(saved.path!, "utf8")).toContain("line1 edited");
  const { readdir } = await import("node:fs/promises");
  const commits = await readdir(join(dir, "env_x-commits"));
  expect(await readFile(join(dir, "env_x-commits", commits[0]!), "utf8")).toContain("rejected commit");
  expect((await snapshotWorktree({ worktreePath: await worktree("clean"), name: "env_y", dir })).status).toBe("clean");
});

it("writes the task folder, excludes it once, copies it into both worktree paths, and does not commit it", async () => {
  const { appendExcludeCommand, persistTaskFolder, prepareWorktree, createWorktree, TASK_FOLDER_EXCLUDE } = await import("../../src/verification/git-integrate");
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { base, worktree } = await repo();
  const taskId = "lptask_folder";
  const plan = "Do the thing.\n";
  await persistTaskFolder({
    taskId, plan,
    exclude: async (line) => { execFileSync("sh", ["-c", appendExcludeCommand(line)], { cwd: base }); },
    writeFile: async (rel, content) => {
      const path = join(base, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
  });
  expect(await readFile(join(base, ".agents", "plans", "items", taskId, "PLAN.md"), "utf8")).toBe(plan);
  const own = join(base, "..", "own", "main");
  const created = await createWorktree({ basePath: base, targetPath: own, name: "lpattempt_folder" });
  expect(created.status).toBe("ready");
  const flat = await worktree("flat");
  await prepareWorktree({ basePath: base, worktreePath: own });
  await prepareWorktree({ basePath: base, worktreePath: flat });
  await prepareWorktree({ basePath: base, worktreePath: own });
  expect(await readFile(join(own, ".agents", "plans", "items", taskId, "PLAN.md"), "utf8")).toBe(plan);
  expect(await readFile(join(flat, ".agents", "plans", "items", taskId, "PLAN.md"), "utf8")).toBe(plan);
  const exclude = await readFile(join(base, ".git", "info", "exclude"), "utf8");
  expect(exclude.split("\n").filter((line) => line === TASK_FOLDER_EXCLUDE)).toEqual([TASK_FOLDER_EXCLUDE]);
  expect(git(base, "status", "--porcelain").trim()).toBe("");
  expect(git(own, "status", "--porcelain").trim()).toBe("");
  expect(git(flat, "status", "--porcelain").trim()).toBe("");
  await writeFile(join(own, "lib.ts"), "export {};\n");
  expect((await integrateWorktree({ basePath: base, worktreePath: own, message: "task folder" })).status).toBe("merged");
  expect(git(base, "show", "--stat", "--format=", "HEAD^2")).not.toContain(".agents/plans/items");
  expect(git(base, "ls-files", ".agents/plans/items")).toBe("");
});
