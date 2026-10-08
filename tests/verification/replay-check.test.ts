import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPLAY_CHECK_FAILED, failureClass } from "../../src/failure-class";
import { previousAttemptBrief, stickyTurnPrompt } from "../../src/server/writer-task";
import { resolveInSameThread } from "../../src/server/writer/sticky";
import { integrateWorktree, type ReplayCheckOutcome } from "../../src/rooms/verification/git-integrate";

// B6: an attempt replayed on a moved main is checked there before it merges; two tasks that merge cleanly can still
// break each other (a semantic clash), and without this the clash merged and mainfix repaired it afterwards.
describe("the task's checks after the replay on a moved main", () => {
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
  /** The task's check: no two source files may declare the same key. Green in each worktree alone, red once both are in. */
  const uniqueKeys = (cwd: string): { exitCode: number; stdout: string; stderr: string } => {
    const res = spawnSync("sh", ["-c", "test $(cat *.key 2>/dev/null | sort | uniq -d | wc -l) -eq 0 || { echo 'duplicate key: A' >&2; exit 1; }"], { cwd, encoding: "utf8" });
    return { exitCode: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
  };
  const replayCheck = (worktree: string, seen: string[] = []) => async (): Promise<ReplayCheckOutcome> => {
    seen.push(git(worktree, "rev-parse", "HEAD"));
    const res = uniqueKeys(worktree);
    return res.exitCode === 0 ? { ok: true } : { ok: false, failed: [{ command: "unique keys", ...res }] };
  };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "lp-replay-base-"));
    one = await mkdtemp(join(tmpdir(), "lp-replay-one-"));
    two = await mkdtemp(join(tmpdir(), "lp-replay-two-"));
    git(base, "init", "-b", "main");
    git(base, "config", "user.name", "Test Committer");
    git(base, "config", "user.email", "test@example.com");
    await writeFile(join(base, "README.md"), "base\n");
    git(base, "add", "-A");
    git(base, "commit", "-m", "initial");
    git(base, "worktree", "add", "-f", "-b", "lane/one", one, "HEAD");
    git(base, "worktree", "add", "-f", "-b", "lane/two", two, "HEAD");
  });

  afterEach(async () => {
    for (const path of [one, two]) { try { git(base, "worktree", "remove", "--force", path); } catch {} }
    for (const path of [base, one, two]) await rm(path, { recursive: true, force: true }).catch(() => {});
  });

  it("holds back a merge whose replayed result is red: main untouched, the check output goes back as a free redo", async () => {
    await work(one, "one", { "one.key": "A\n" });
    await work(two, "two", { "two.key": "A\n" });
    // Each worktree alone is green, so the writer's own checks passed.
    expect(uniqueKeys(one).exitCode).toBe(0);
    expect(uniqueKeys(two).exitCode).toBe(0);
    expect((await integrateWorktree({ basePath: base, worktreePath: one, message: "one", replayCheck: replayCheck(one) })).status).toBe("merged");
    const mainHead = git(base, "rev-parse", "HEAD");

    const res = await integrateWorktree({ basePath: base, worktreePath: two, message: "two", replayCheck: replayCheck(two) });

    expect(res.status).toBe("conflict");
    expect(res.conflicts).toEqual([]);
    expect(res.reason).toBe(`${REPLAY_CHECK_FAILED}: verification failed (unique keys)`);
    expect(res.checks?.[0]).toMatchObject({ command: "unique keys", exitCode: 1, stderr: "duplicate key: A\n" });
    // Nothing merged; the attempt stays replayed on main in its worktree for the writer to fix there.
    expect(git(base, "rev-parse", "HEAD")).toBe(mainHead);
    expect(spawnSync("test", ["-e", join(base, "two.key")]).status).not.toBe(0);
    expect(git(two, "merge-base", "--is-ancestor", mainHead, "HEAD") === "").toBe(true);
    expect(await readFile(join(two, "one.key"), "utf8")).toBe("A\n");
  });

  it("merges a replayed attempt whose checks stay green, after running them once on the replayed tip", async () => {
    await work(one, "one", { "one.key": "A\n" });
    await work(two, "two", { "two.key": "B\n" });
    expect((await integrateWorktree({ basePath: base, worktreePath: one, message: "one" })).status).toBe("merged");
    const seen: string[] = [];

    const res = await integrateWorktree({ basePath: base, worktreePath: two, message: "two", replayCheck: replayCheck(two, seen) });

    expect(res).toMatchObject({ status: "merged", rebased: true });
    expect(seen).toHaveLength(1);
    expect(git(base, "rev-parse", "HEAD^2")).toBe(seen[0]);
  });

  it("runs no check when main did not move (nothing was replayed)", async () => {
    await work(one, "one", { "one.key": "A\n" });
    const check = vi.fn(async (): Promise<ReplayCheckOutcome> => ({ ok: false, failed: [{ command: "never", exitCode: 1, stdout: "", stderr: "" }] }));

    const res = await integrateWorktree({ basePath: base, worktreePath: one, message: "one", replayCheck: check });

    expect(res.status).toBe("merged");
    expect(check).not.toHaveBeenCalled();
  });

  it("runs no check when the replay itself conflicts (the existing conflict path reports it)", async () => {
    await work(one, "one", { "README.md": "one\n" });
    await work(two, "two", { "README.md": "two\n" });
    expect((await integrateWorktree({ basePath: base, worktreePath: one, message: "one" })).status).toBe("merged");
    const check = vi.fn(async (): Promise<ReplayCheckOutcome> => ({ ok: true }));

    const res = await integrateWorktree({ basePath: base, worktreePath: two, message: "two", replayCheck: check });

    expect(res).toMatchObject({ status: "conflict", conflicts: ["README.md"] });
    expect(check).not.toHaveBeenCalled();
  });

  it("reads as a free merge redo for the same writer, which is shown the check's output", () => {
    const reason = `merge_conflict: main changed since this attempt started: ${REPLAY_CHECK_FAILED}: verification failed (unique keys)`;
    expect(failureClass("validation_failed", reason)).toBe("merge");
    expect(resolveInSameThread("validation_failed", reason)).toBe(true);
    const brief = previousAttemptBrief({ status: "validation_failed", reason, verification: [{ command: "unique keys", exitCode: 1, stdout: "", stderr: "duplicate key: A" }] });
    expect(brief).toContain("unique keys");
    expect(brief).toContain("duplicate key: A");
    expect(stickyTurnPrompt({ kind: "merge", task: { id: "t", title: "t", owns_paths: [], verification: [], expected_outputs: [], read_first: [], acceptance: [] } as never, previousAttempt: brief })).toContain("duplicate key: A");
  });
});
