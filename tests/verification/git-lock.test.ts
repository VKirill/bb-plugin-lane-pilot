import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Real repositories and locks: inside the sandboxed check the suite runs ~2.5x slower, and vitest's 5 s
// default timed these out (2026-10-06 check log); 120 s matches the npm-install test in git-integrate.test.ts.
vi.setConfig({ testTimeout: 120_000 });
import { integrateWorktree, recoverStaleGitLock } from "../../src/verification/git-integrate";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

async function repo() {
  const base = join(await mkdtemp(join(tmpdir(), "lp-lock-")), "main");
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  await writeFile(join(base, "server.ts"), "line1\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");
  const worktree = async (name: string) => { const path = join(base, "..", name); git(base, "worktree", "add", "-q", "-b", `bb/${name}`, path, "main"); return path; };
  return { base, worktree };
}

const hasLsof = spawnSync("lsof", ["-v"]).error === undefined;
const aged = async (path: string, seconds: number) => { const t = new Date(Date.now() - seconds * 1000); await utimes(path, t, t); };
const lockOf = (base: string) => join(base, ".git", "index.lock");

describe("stale git index.lock recovery", () => {
  it("leaves a fresh lock alone", async () => {
    const { base } = await repo();
    await writeFile(lockOf(base), "");
    await aged(lockOf(base), 30);
    expect(await recoverStaleGitLock(base)).toBeNull();
    expect(existsSync(lockOf(base))).toBe(true);
  });

  it.skipIf(!hasLsof)("moves aside a lock older than 60 s that no process holds", async () => {
    const { base } = await repo();
    await writeFile(lockOf(base), "");
    await aged(lockOf(base), 120);
    const aside = await recoverStaleGitLock(base);
    expect(aside).toMatch(/index\.lock\.stale-\d+$/);
    expect(existsSync(lockOf(base))).toBe(false);
    expect(existsSync(aside!)).toBe(true);
  });

  it.skipIf(!hasLsof)("does not touch an old lock while a process holds it open", async () => {
    const { base } = await repo();
    await writeFile(lockOf(base), "");
    const holder = spawn("sh", ["-c", `exec 3<"${lockOf(base)}"; sleep 30`], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await aged(lockOf(base), 3600);
      expect(await recoverStaleGitLock(base)).toBeNull();
      expect(existsSync(lockOf(base))).toBe(true);
    } finally { holder.kill(); }
  });

  it("without lsof only a lock older than 10 minutes counts", async () => {
    const { base } = await repo();
    const bin = await mkdtemp(join(tmpdir(), "lp-nolsof-"));
    await symlink(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    const path = process.env.PATH;
    process.env.PATH = bin;
    try {
      await writeFile(lockOf(base), "");
      await aged(lockOf(base), 300);
      expect(await recoverStaleGitLock(base)).toBeNull();
      await aged(lockOf(base), 700);
      expect(await recoverStaleGitLock(base)).toMatch(/index\.lock\.stale-\d+$/);
    } finally { process.env.PATH = path; }
  });

  it.skipIf(!hasLsof)("finds a worktree's own lock, so the merge goes through", async () => {
    const { base, worktree } = await repo();
    const a = await worktree("a");
    const lock = join(git(a, "rev-parse", "--absolute-git-dir").trim(), "index.lock");
    await writeFile(lock, "");
    await aged(lock, 3600);
    await writeFile(join(a, "lib.ts"), "export const x = 1;\n");
    expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "task a" })).status).toBe("merged");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("a merge blocked by a lock", () => {
  // SelfyStudio 2026-10-04: a fresh-looking index.lock in main failed every merge, reported as «merge_conflict … main changed».
  it("is a failed merge naming git's error, not a conflict with no files", async () => {
    const { base, worktree } = await repo();
    const path = await worktree("w1");
    await writeFile(join(path, "new.ts"), "x\n");
    await writeFile(lockOf(base), "");
    await aged(lockOf(base), 5); // fresh: recovery leaves it, so git refuses
    const result = await integrateWorktree({ basePath:base, worktreePath:path, message:"t" });
    expect(result.status).toBe("failed");
    expect(result.conflicts).toEqual([]);
    expect(result.reason).toMatch(/git merge failed: .*index\.lock/s);
  });

  it.skipIf(!hasLsof)("merges once a stale lock is moved aside", async () => {
    const { base, worktree } = await repo();
    const path = await worktree("w2");
    await writeFile(join(path, "new.ts"), "x\n");
    await writeFile(lockOf(base), "");
    await aged(lockOf(base), 3600);
    expect((await integrateWorktree({ basePath:base, worktreePath:path, message:"t" })).status).toBe("merged");
  });
});

describe("a merge cut off midway", () => {
  it("is aborted once older than 10 minutes, so the next merge can run", async () => {
    const { abortStaleMerge } = await import("../../src/verification/git-integrate");
    const { base, worktree } = await repo();
    const path = await worktree("w3");
    await writeFile(join(path, "server.ts"), "theirs\n"); git(path, "commit", "-qam", "theirs");
    await writeFile(join(base, "server.ts"), "ours\n"); git(base, "commit", "-qam", "ours");
    spawnSync("git", ["merge", "--no-edit", "bb/w3"], { cwd: base }); // conflicts: MERGE_HEAD stays
    const head = join(base, ".git", "MERGE_HEAD");
    expect(existsSync(head)).toBe(true);
    expect(await abortStaleMerge(base)).toBe(false); // fresh: maybe someone is resolving it
    await aged(head, 3600);
    expect(await abortStaleMerge(base)).toBe(true);
    expect(existsSync(head)).toBe(false);
  });
});

describe("a git failure while index.lock stands", () => {
  // Linux git 2.43 says just «error: Unable to write index.» with no lock in the text (OVH 2026-10-06);
  // macOS prints the lock path itself. Either way the reason must name the lock, so it classes as infra.
  it("names the lock even when git's own wording omits it", async () => {
    const { withIndexLockNote } = await import("../../src/verification/git-integrate");
    const { base } = await repo();
    expect(await withIndexLockNote(base, "error: Unable to write index.")).toBe("error: Unable to write index.");
    // git's own wording already carries the lock: nothing is added twice.
    expect(await withIndexLockNote(base, "fatal: Unable to create '/repo/.git/index.lock': File exists"))
      .toBe("fatal: Unable to create '/repo/.git/index.lock': File exists");
    await writeFile(lockOf(base), "");
    expect(await withIndexLockNote(base, "error: Unable to write index.")).toBe("error: Unable to write index. (index.lock present)");
  });

  it("classes a Linux-worded lock failure as infra", async () => {
    const { failureClass } = await import("../../src/failure-class");
    expect(failureClass("validation_failed", "git merge failed: error: Unable to write index.")).toBe("infra");
    expect(failureClass("validation_failed", "git merge failed: error: Unable to write index. (index.lock present)")).toBe("infra");
  });
});
