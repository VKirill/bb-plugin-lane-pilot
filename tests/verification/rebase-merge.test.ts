import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { integrateWorktree } from "../../src/verification/git-integrate";

// B6: an attempt whose main moved meanwhile is replayed on the current main under the integration lock, so two
// non-overlapping tasks merged one after the other are both accepted without another writer turn.
describe("rebase of the attempt onto the current main before the merge", () => {
  let base: string;
  let one: string;
  let two: string;

  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
    return res.stdout.trim();
  };
  const work = async (path: string, name: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) await writeFile(join(path, file), text);
    git(path, "add", "-A");
    git(path, "commit", "-m", `feat: ${name}`);
  };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "lp-rebase-base-"));
    one = await mkdtemp(join(tmpdir(), "lp-rebase-one-"));
    two = await mkdtemp(join(tmpdir(), "lp-rebase-two-"));
    git(base, "init", "-b", "main");
    git(base, "config", "user.name", "Test Committer");
    git(base, "config", "user.email", "test@example.com");
    await writeFile(join(base, "shared.ts"), ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", ""].join("\n"));
    git(base, "add", "-A");
    git(base, "commit", "-m", "initial");
    git(base, "worktree", "add", "-b", "lane/one", one, "HEAD");
    git(base, "worktree", "add", "-b", "lane/two", two, "HEAD");
  });

  afterEach(async () => {
    for (const path of [one, two]) { try { git(base, "worktree", "remove", "--force", path); } catch {} }
    for (const path of [base, one, two]) await rm(path, { recursive: true, force: true }).catch(() => {});
  });

  it("merges two non-overlapping attempts in a row, both on the main the other left, no writer rerun", async () => {
    await work(one, "one", { "one.ts": "export const one = 1;\n" });
    await work(two, "two", { "two.ts": "export const two = 2;\n" });

    const first = await integrateWorktree({ basePath: base, worktreePath: one, message: "one" });
    expect(first).toMatchObject({ status: "merged" });
    expect(first.rebased).toBeUndefined();
    const mainAfterFirst = git(base, "rev-parse", "HEAD");

    const second = await integrateWorktree({ basePath: base, worktreePath: two, message: "two" });
    expect(second).toMatchObject({ status: "merged", rebased: true });
    // The attempt's commit now sits directly on the first merge: the second parent of the merge is its child.
    expect(git(base, "rev-parse", "HEAD^2^")).toBe(mainAfterFirst);
    expect(await readFile(join(base, "one.ts"), "utf8")).toBe("export const one = 1;\n");
    expect(await readFile(join(base, "two.ts"), "utf8")).toBe("export const two = 2;\n");
  });

  it("merges two edits of different parts of one file", async () => {
    await work(one, "one", { "shared.ts": ["X1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", ""].join("\n") });
    await work(two, "two", { "shared.ts": ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "X9", ""].join("\n") });
    expect((await integrateWorktree({ basePath: base, worktreePath: one, message: "one" })).status).toBe("merged");
    expect(await integrateWorktree({ basePath: base, worktreePath: two, message: "two" })).toMatchObject({ status: "merged", rebased: true });
    expect(await readFile(join(base, "shared.ts"), "utf8")).toBe(["X1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "X9", ""].join("\n"));
  });

  it("leaves a real conflict as it was: main untouched, the attempt's branch and worktree unchanged, conflict named", async () => {
    await work(one, "one", { "shared.ts": ["ONE", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", ""].join("\n") });
    await work(two, "two", { "shared.ts": ["TWO", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", ""].join("\n") });
    expect((await integrateWorktree({ basePath: base, worktreePath: one, message: "one" })).status).toBe("merged");
    const mainHead = git(base, "rev-parse", "HEAD");
    const attemptTip = git(two, "rev-parse", "HEAD");

    const res = await integrateWorktree({ basePath: base, worktreePath: two, message: "two" });

    expect(res).toMatchObject({ status: "conflict", conflicts: ["shared.ts"] });
    expect(res.rebased).toBeUndefined();
    expect(git(base, "rev-parse", "HEAD")).toBe(mainHead);
    expect(git(base, "status", "--porcelain")).toBe("");
    expect(git(two, "rev-parse", "HEAD")).toBe(attemptTip);
    expect(git(two, "status", "--porcelain")).toBe("");
    expect(spawnSync("git", ["rev-parse", "--verify", "REBASE_HEAD"], { cwd: two }).status).not.toBe(0);
  });

  it("replays a BB-managed bb/ attempt branch on the current main too", async () => {
    const managed = await mkdtemp(join(tmpdir(), "lp-rebase-bb-"));
    try {
      git(base, "worktree", "add", "-b", "bb/attempt", managed, "HEAD");
      await work(managed, "managed", { "managed.ts": "export const managed = 1;\n" });
      await work(one, "one", { "one.ts": "export const one = 1;\n" });
      expect((await integrateWorktree({ basePath: base, worktreePath: one, message: "one" })).status).toBe("merged");
      const mainAfterFirst = git(base, "rev-parse", "HEAD");

      const res = await integrateWorktree({ basePath: base, worktreePath: managed, message: "managed" });

      expect(res).toMatchObject({ status: "merged", rebased: true });
      expect(git(base, "rev-parse", "HEAD^2^")).toBe(mainAfterFirst);
    } finally {
      try { git(base, "worktree", "remove", "--force", managed); } catch {}
      await rm(managed, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("does not rewrite a branch that is not Lane Pilot's own", async () => {
    const other = await mkdtemp(join(tmpdir(), "lp-rebase-other-"));
    try {
      git(base, "worktree", "add", "-b", "area/other", other, "HEAD");
      await work(other, "other", { "other.ts": "export const other = 1;\n" });
      await work(one, "one", { "one.ts": "export const one = 1;\n" });
      expect((await integrateWorktree({ basePath: base, worktreePath: one, message: "one" })).status).toBe("merged");
      const tip = git(other, "rev-parse", "HEAD");

      const res = await integrateWorktree({ basePath: base, worktreePath: other, message: "other" });

      expect(res.status).toBe("merged");
      expect(res.rebased).toBeUndefined();
      expect(git(other, "rev-parse", "HEAD")).toBe(tip);
    } finally {
      try { git(base, "worktree", "remove", "--force", other); } catch {}
      await rm(other, { recursive: true, force: true }).catch(() => {});
    }
  });
});
