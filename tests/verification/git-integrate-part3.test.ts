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
  const { snapshotWorktree } = await import("../../src/rooms/verification/git-integrate");
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
  const { appendExcludeCommand, persistTaskFolder, prepareWorktree, createWorktree, TASK_FOLDER_EXCLUDE } = await import("../../src/rooms/verification/git-integrate");
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

// A host worker blocked in git cannot answer the daemon (OVH, 2026-10-05): the merge's git runs leave the event loop free.
it("keeps the event loop running while it merges", async () => {
  const { base, worktree } = await repo();
  const a = await worktree("a");
  await writeFile(join(a, "lib.ts"), "export const x = 1;\n");
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try { expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "task a" })).status).toBe("merged"); }
  finally { clearInterval(timer); }
  expect(ticks).toBeGreaterThan(5);
});
