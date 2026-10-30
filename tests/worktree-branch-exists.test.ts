import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree, worktreeOfBranch } from "../src/rooms/verification/git-integrate";

/**
 * An attempt's worktree is created again when the answer of the first create was lost (a plugin reload, a host call that timed out
 * on a machine deep in swap): its branch lane/<attempt> already exists, and `git worktree add -b` failed with «a branch named … already
 * exists», which parked the task (Vampirism Fire, 2026-10-28).
 */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "lp-wt-exists-"));
  const base = join(root, "base");
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  git(base, "config", "user.email", "t@t");
  git(base, "config", "user.name", "t");
  await writeFile(join(base, "a.txt"), "one\n");
  git(base, "add", "-A");
  git(base, "commit", "-q", "-m", "one");
  return { root, base, target: join(root, "wt", "lpattempt_x") };
}

describe("an attempt's worktree whose branch already exists", () => {
  it("is taken as it is when it still stands", async () => {
    const { root, base, target } = await repo();
    try {
      const first = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x" });
      expect(first).toMatchObject({ status: "ready", path: target, branch: "lane/lpattempt_x" });
      await writeFile(join(target, "work.txt"), "kept\n");
      const again = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x" });
      expect(again).toMatchObject({ status: "ready", path: target, branch: "lane/lpattempt_x", reason: null, baseSha: first.baseSha });
      expect(readFileSync(join(target, "work.txt"), "utf8")).toBe("kept\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("is made again on the same branch, with its commits, when the folder is gone", async () => {
    const { root, base, target } = await repo();
    try {
      await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x" });
      await writeFile(join(target, "work.txt"), "committed\n");
      git(target, "add", "-A");
      git(target, "commit", "-q", "-m", "writer");
      const tip = git(target, "rev-parse", "HEAD");
      await rm(target, { recursive: true, force: true });
      const again = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x" });
      expect(again).toMatchObject({ status: "ready", path: target, branch: "lane/lpattempt_x" });
      expect(git(target, "rev-parse", "HEAD")).toBe(tip);
      expect(git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("lane/lpattempt_x");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("is attached to the branch when no worktree holds it", async () => {
    const { root, base, target } = await repo();
    try {
      git(base, "branch", "lane/lpattempt_x");
      expect(existsSync(target)).toBe(false);
      const made = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x" });
      expect(made).toMatchObject({ status: "ready", path: target, branch: "lane/lpattempt_x" });
      expect(git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("lane/lpattempt_x");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reuses an unmerged branch that belongs to the same task", async () => {
    const { root, base, target } = await repo();
    try {
      await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x", taskId: "T1" });
      await writeFile(join(target, "work.txt"), "kept\n");
      git(target, "add", "-A");
      git(target, "commit", "-q", "-m", "writer");
      const tip = git(target, "rev-parse", "HEAD");
      await rm(target, { recursive: true, force: true });
      const again = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x", taskId: "T1" });
      expect(again).toMatchObject({ status: "ready", path: target, branch: "lane/lpattempt_x" });
      expect(git(target, "rev-parse", "HEAD")).toBe(tip);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("deletes a merged branch and starts the retry from current HEAD", async () => {
    const { root, base, target } = await repo();
    try {
      await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x", taskId: "T1" });
      await writeFile(join(target, "work.txt"), "old\n");
      git(target, "add", "-A");
      git(target, "commit", "-q", "-m", "writer");
      const old = git(target, "rev-parse", "HEAD");
      git(base, "merge", "--no-ff", "--no-edit", "lane/lpattempt_x");
      await writeFile(join(base, "later.txt"), "later\n");
      git(base, "add", "-A");
      git(base, "commit", "-q", "-m", "later");
      const head = git(base, "rev-parse", "HEAD");
      const again = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x", taskId: "T1" });
      expect(again.status).toBe("ready");
      expect(git(again.path!, "rev-parse", "HEAD")).toBe(head);
      expect(git(again.path!, "rev-parse", "HEAD")).not.toBe(old);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("deletes a branch that belongs to another task", async () => {
    const { root, base, target } = await repo();
    try {
      await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x", taskId: "T1" });
      await writeFile(join(target, "work.txt"), "theirs\n");
      git(target, "add", "-A");
      git(target, "commit", "-q", "-m", "theirs");
      const old = git(target, "rev-parse", "HEAD");
      const main = git(base, "rev-parse", "HEAD");
      const again = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_x", taskId: "T2" });
      expect(again.status).toBe("ready");
      expect(git(again.path!, "rev-parse", "HEAD")).toBe(main);
      expect(git(again.path!, "rev-parse", "HEAD")).not.toBe(old);
      expect(git(base, "config", "--get", "branch.lane/lpattempt_x.laneTask")).toBe("T2");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reads the folder that holds a branch from git's porcelain list", () => {
    const porcelain = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /w/lpattempt_x\nHEAD bbb\nbranch refs/heads/lane/lpattempt_x\n";
    expect(worktreeOfBranch(porcelain, "lane/lpattempt_x")).toBe("/w/lpattempt_x");
    expect(worktreeOfBranch(porcelain, "lane/other")).toBeNull();
  });
});
