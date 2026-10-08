import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { integrateWorktree, prepareWorktree } from "../../src/rooms/verification/git-integrate";

// Drill 2026-10-07 20:29 (provider_limit): the project-life stage had `git add`ed CHANGELOG, PROGRESS and plan items in the
// base checkout and not yet committed them when another task merged. Git's ort strategy refuses any merge while the index
// differs from HEAD, in a message without tab-indented files, so it read as «merge_failed» (infra) instead of a wait.
describe("a merge into a base that holds machine-written bookkeeping the project-life stage has not committed yet", () => {
  let base: string;
  let wt: string;

  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
    return res.stdout.trim();
  };
  const PLANS = [".agents/plans/items/t-one/PLAN.md", ".agents/plans/items/t-two/PLAN.md"];
  const BOOKKEEPING = [".agents/PROGRESS.md", ".agents/CHANGELOG.md", ...PLANS];

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "lp-dirty-bk-base-"));
    wt = join(await mkdtemp(join(tmpdir(), "lp-dirty-bk-wt-")), "wt");
    git(base, "init", "-b", "main");
    git(base, "config", "user.name", "Test Committer");
    git(base, "config", "user.email", "test@example.com");
    await mkdir(join(base, ".agents/plans/items/t-one"), { recursive: true });
    await mkdir(join(base, ".agents/plans/items/t-two"), { recursive: true });
    await writeFile(join(base, ".agents/PROGRESS.md"), "progress v1\n");
    await writeFile(join(base, ".agents/CHANGELOG.md"), "# Changelog\n- one\n");
    for (const plan of PLANS) await writeFile(join(base, plan), "plan\n");
    await writeFile(join(base, "owner.ts"), "export const owner = 1;\n");
    // The plan items are tracked here (a project-life commit added them) although the task folder is excluded.
    git(base, "add", "-A", "-f");
    git(base, "commit", "-m", "initial");
    git(base, "worktree", "add", "-b", "lane/attempt", wt, "HEAD");
    git(wt, "config", "user.name", "Test Committer");
    git(wt, "config", "user.email", "test@example.com");
  });

  afterEach(async () => {
    try { git(base, "worktree", "remove", "--force", wt); } catch {}
    await rm(base, { recursive: true, force: true }).catch(() => {});
    await rm(join(wt, ".."), { recursive: true, force: true }).catch(() => {});
  });

  const NEW = {
    ".agents/PROGRESS.md": "progress v2 (project-life)\n",
    ".agents/CHANGELOG.md": "# Changelog\n- one\n- two (project-life)\n",
    ".agents/plans/items/t-one/PLAN.md": "plan\n- [x] done (project-life)\n",
    ".agents/plans/items/t-two/PLAN.md": "plan\n- [x] done (project-life)\n",
  } as Record<string, string>;
  const projectLifeWrites = async (stage: boolean) => {
    for (const path of BOOKKEEPING) await writeFile(join(base, path), NEW[path]!);
    if (stage) git(base, "add", "-f", "--", ...BOOKKEEPING);
  };
  const expectBookkeepingKept = async () => {
    for (const path of BOOKKEEPING) expect(await readFile(join(base, path), "utf8"), path).toBe(NEW[path]);
  };

  it("reproduces: staged but uncommitted bookkeeping no longer fails the merge, the work lands and the edits stay", async () => {
    await projectLifeWrites(true);
    await writeFile(join(wt, "note.md"), "note\n");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "note", stagedWaitMs: 300 });

    expect(res, JSON.stringify(res)).toMatchObject({ status: "merged" });
    expect(await readFile(join(base, "note.md"), "utf8")).toBe("note\n");
    await expectBookkeepingKept();
    // Nothing is lost and nothing is discarded: the machine-written files were committed as they stood.
    expect(git(base, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(git(base, "show", "HEAD~1:.agents/PROGRESS.md")).toBe("progress v2 (project-life)");
  });

  it("waits for the stage's own commit when it lands within the wait, and does not commit for it", async () => {
    await projectLifeWrites(true);
    await writeFile(join(wt, "note.md"), "note\n");
    setTimeout(() => { git(base, "commit", "-m", "chore(progress): update project memory"); }, 400);

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "note", stagedWaitMs: 5_000 });

    expect(res, JSON.stringify(res)).toMatchObject({ status: "merged" });
    await expectBookkeepingKept();
    const subjects = git(base, "log", "--format=%s", "-5");
    expect(subjects).toContain("chore(progress): update project memory");
    expect(subjects).not.toContain("settle");
  });

  it("uncommitted (unstaged) bookkeeping in the base is not in the way and stays uncommitted", async () => {
    await projectLifeWrites(false);
    // The attempt is prepared while the stage writes: its copy of the task folder must not carry the stage's edits.
    await prepareWorktree({ basePath: base, worktreePath: wt });
    await writeFile(join(wt, "note.md"), "note\n");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "note" });

    expect(res, JSON.stringify(res)).toMatchObject({ status: "merged" });
    await expectBookkeepingKept();
    expect(git(base, "status", "--porcelain", "--untracked-files=no").split("\n").length).toBe(BOOKKEEPING.length);
    expect(git(base, "show", "HEAD^2:.agents/plans/items/t-one/PLAN.md")).toBe("plan");
  });

  it("an attempt that itself changed the bookkeeping files merges the same way", async () => {
    await projectLifeWrites(true);
    await writeFile(join(wt, ".agents/PROGRESS.md"), "attempt progress\n");
    await writeFile(join(wt, ".agents/CHANGELOG.md"), "# Changelog\n- attempt\n");
    await writeFile(join(wt, "note.md"), "note\n");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "note", stagedWaitMs: 300 });

    expect(res, JSON.stringify(res)).toMatchObject({ status: "merged" });
    await expectBookkeepingKept();
  });

  it("an owner's staged product file is never committed for them: the merge waits as a dirty base and names the real file", async () => {
    await projectLifeWrites(true);
    await writeFile(join(base, "owner.ts"), "export const owner = 'staged by the owner';\n");
    git(base, "add", "owner.ts");
    await writeFile(join(wt, "note.md"), "note\n");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "note", stagedWaitMs: 300 });

    expect(res.status).toBe("conflict");
    expect(res.reason).toMatch(/^base checkout has uncommitted changes/);
    expect(res.conflicts).toContain("owner.ts");
    expect(git(base, "diff", "--cached", "--name-only").split("\n")).toContain("owner.ts");
    expect(await readFile(join(base, "owner.ts"), "utf8")).toBe("export const owner = 'staged by the owner';\n");
    await expectBookkeepingKept();
  });

  it("an owner's uncommitted product file the attempt also changes still waits (dirty base), never merge_failed", async () => {
    await projectLifeWrites(false);
    await writeFile(join(base, "owner.ts"), "export const owner = 'dirty';\n");
    await writeFile(join(wt, "owner.ts"), "export const owner = 'attempt';\n");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "owner" });

    expect(res.status).toBe("conflict");
    expect(res.reason).toBe("base checkout has uncommitted changes in files this attempt also changes");
    expect(res.conflicts).toEqual(["owner.ts"]);
    expect(await readFile(join(base, "owner.ts"), "utf8")).toBe("export const owner = 'dirty';\n");
    await expectBookkeepingKept();
  });
});
