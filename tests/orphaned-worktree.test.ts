import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktree, orphanedWorktree, removeLaneWorktree, snapshotWorktree } from "../src/rooms/verification/git-integrate";

const sh = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/**
 * SelfyStudio 2026-10-24: a 20.10 worktree removal stopped half way, so its admin dir was gone and its folder stayed.
 * git gave that admin name to a new worktree, and a cleanup's `git add -A` in the old folder wrote the new worktree's
 * index: 14 880 files «deleted», the attempt blocked as out of scope.
 */
async function halfRemovedThenReused() {
  const home = await mkdtemp(join(tmpdir(), "lp-orphan-"));
  dirs.push(home);
  const base = join(home, "repo");
  await mkdir(join(base, "apps"), { recursive: true });
  await writeFile(join(base, "apps", "a.ts"), "a\n");
  await writeFile(join(base, "README.md"), "r\n");
  sh(base, "init", "-q", "-b", "main");
  sh(base, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  sh(base, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const root = join(home, ".lane-pilot", "worktrees");
  const old = join(root, "lpattempt_old", "repo");
  expect((await createWorktree({ basePath: base, targetPath: old, name: "lpattempt_old" })).status).toBe("ready");
  // The removal stopped half way: the admin dir and part of the files are gone, the folder and its .git stay.
  await rm(join(base, ".git", "worktrees", "repo"), { recursive: true, force: true });
  await rm(join(old, "apps"), { recursive: true, force: true });
  return { base, root, old };
}

describe("orphaned Lane Pilot worktree folders", () => {
  it("a new worktree that gets the old admin name retires the old folder", async () => {
    const { base, root, old } = await halfRemovedThenReused();
    const fresh = join(root, "lpattempt_new", "repo");
    const made = await createWorktree({ basePath: base, targetPath: fresh, name: "lpattempt_new" });
    expect(made.status).toBe("ready");
    expect(existsSync(old)).toBe(false);
    expect(sh(fresh, "status", "--porcelain")).toBe("");
  });

  it("cleaning up the old attempt never touches the new worktree's index", async () => {
    const { base, root, old } = await halfRemovedThenReused();
    // The new worktree made by plain git, as before the fix: the old folder now points at its admin dir.
    const fresh = join(root, "lpattempt_new", "repo");
    await mkdir(join(root, "lpattempt_new"), { recursive: true });
    sh(base, "worktree", "add", "-q", "-b", "lane/lpattempt_new", fresh, "HEAD");
    expect(await orphanedWorktree(old)).not.toBeNull();
    expect(await orphanedWorktree(fresh)).toBeNull();
    expect((await snapshotWorktree({ worktreePath: old, name: "lpattempt_old", dir: join(root, "..", "released") })).status).toBe("missing");
    expect((await removeLaneWorktree({ basePath: base, worktreePath: old, releaseDir: join(root, "..", "released") })).removed).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(sh(fresh, "status", "--porcelain")).toBe("");
    expect(sh(fresh, "ls-files")).toContain("apps/a.ts");
  });

  it("a healthy worktree is not orphaned, and the main checkout is no linked worktree", async () => {
    const { base, root } = await halfRemovedThenReused();
    const fresh = join(root, "lpattempt_new", "repo");
    await createWorktree({ basePath: base, targetPath: fresh, name: "lpattempt_new" });
    await mkdir(join(fresh, "apps", "deep"), { recursive: true });
    expect(await orphanedWorktree(join(fresh, "apps", "deep"))).toBeNull();
    expect(await orphanedWorktree(base)).toBeNull();
  });
});
