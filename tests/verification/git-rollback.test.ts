import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createWorktree, integrateWorktree, removeLaneWorktree } from "../../src/rooms/verification/git-integrate";
import { mergeInfo, revertCommitsInWorktree, worktreeState } from "../../src/rooms/verification/git-rollback";
import { git, repo } from "./git-integrate-helpers";

// Real repositories and worktrees, as the other git-integrate tests: slow under the sandbox.
vi.setConfig({ testTimeout: 120_000 });

const exists = (path: string) => stat(path).then(() => true, () => false);

it("records the base and what a merge changed, deletions included, and finds the merge again by its attempt trailer", async () => {
  const { base, worktree } = await repo();
  await writeFile(join(base, "gone.ts"), "bye\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "add gone");
  const before = git(base, "rev-parse", "HEAD").trim();
  const a = await worktree("a");
  await writeFile(join(a, "lib.ts"), "export const x = 1;\n");
  await rm(join(a, "gone.ts"));
  const merged = await integrateWorktree({ basePath: base, worktreePath: a, message: "a: add lib\n\nLane-Pilot-Attempt: lpattempt_a1" });
  expect(merged.status).toBe("merged");
  expect(merged.base).toBe(before);
  expect(merged.changed).toEqual(expect.arrayContaining([{ status: "A", path: "lib.ts" }, { status: "D", path: "gone.ts" }]));
  const info = await mergeInfo({ basePath: base, attemptId: "lpattempt_a1" });
  expect(info).toMatchObject({ status: "found", commit: merged.commit, base: before, inMain: true });
  expect(info.changed).toEqual(merged.changed);
  // a10 is not a1
  expect((await mergeInfo({ basePath: base, attemptId: "lpattempt_a" })).status).toBe("missing");
});

it("createWorktree names the commit it starts from", async () => {
  const { base } = await repo();
  const head = git(base, "rev-parse", "HEAD").trim();
  const made = await createWorktree({ basePath: base, targetPath: join(tmpdir(), `lp-rb-${Date.now()}`, "wt"), name: `rb-${Date.now()}` });
  expect(made).toMatchObject({ status: "ready", baseSha: head });
  await writeFile(join(base, "more.ts"), "x\n"); git(base, "add", "-A"); git(base, "commit", "-qm", "more");
  const old = await createWorktree({ basePath: base, targetPath: join(tmpdir(), `lp-rb2-${Date.now()}`, "wt"), name: `rb2-${Date.now()}`, commit: head });
  expect(old).toMatchObject({ status: "ready", baseSha: head });
  expect(await exists(join(old.path!, "more.ts"))).toBe(false);
});

it("worktreeState says where a worktree started and what it changed, deletions and new files included", async () => {
  const { base, worktree } = await repo();
  const head = git(base, "rev-parse", "HEAD").trim();
  const a = await worktree("a");
  await writeFile(join(a, "server.ts"), "changed\n");
  await writeFile(join(a, "new.ts"), "n\n");
  await rm(join(a, "server.ts"));
  const state = await worktreeState({ basePath: base, worktreePath: a });
  expect(state).toMatchObject({ status: "ready", base: head, dirty: 2, ahead: 0 });
  expect(state.changed).toEqual([{ path: "new.ts", status: "A" }, { path: "server.ts", status: "D" }]);
  expect((await worktreeState({ basePath: base, worktreePath: join(a, "nope") })).status).toBe("missing");
});

it("reverts a merged task with git revert in a scratch worktree and merges the revert", async () => {
  const { base, worktree } = await repo();
  const a = await worktree("a");
  await writeFile(join(a, "lib.ts"), "export const x = 1;\n");
  const merged = await integrateWorktree({ basePath: base, worktreePath: a, message: "a: lib\n\nLane-Pilot-Attempt: lpattempt_r1" });
  const info = await mergeInfo({ basePath: base, attemptId: "lpattempt_r1" });
  const scratch = await createWorktree({ basePath: base, targetPath: join(tmpdir(), `lp-rv-${Date.now()}`, "wt"), name: `revert-${Date.now()}` });
  const reverted = await revertCommitsInWorktree({ worktreePath: scratch.path!, commits: [info.commit!] });
  expect(reverted.status).toBe("reverted");
  expect(await exists(join(scratch.path!, "lib.ts"))).toBe(false);
  const landed = await integrateWorktree({ basePath: base, worktreePath: scratch.path!, message: "Revert a", removeWorktree: true });
  expect(landed.status).toBe("merged");
  expect(await exists(join(base, "lib.ts"))).toBe(false);
  // history only grew: the task's own merge is still there
  expect(git(base, "merge-base", "--is-ancestor", merged.commit!, "HEAD") ?? "").toBe("");
});

it("refuses a revert that conflicts with a later commit and names the commit and the file", async () => {
  const { base, worktree } = await repo();
  const a = await worktree("a");
  await writeFile(join(a, "server.ts"), "line1 from a\nline2\nline3\n");
  await integrateWorktree({ basePath: base, worktreePath: a, message: "a: edit\n\nLane-Pilot-Attempt: lpattempt_c1" });
  const b = await worktree("b");
  await writeFile(join(b, "server.ts"), "line1 from b\nline2\nline3\n");
  const second = await integrateWorktree({ basePath: base, worktreePath: b, message: "b: edit the same line", committedOnly: false });
  expect(second.status).toBe("merged");
  const info = await mergeInfo({ basePath: base, attemptId: "lpattempt_c1" });
  const scratch = await createWorktree({ basePath: base, targetPath: join(tmpdir(), `lp-rc-${Date.now()}`, "wt"), name: `revert-c-${Date.now()}` });
  const reverted = await revertCommitsInWorktree({ worktreePath: scratch.path!, commits: [info.commit!] });
  expect(reverted.status).toBe("conflict");
  expect(reverted.conflicts).toEqual(["server.ts"]);
  expect(reverted.later.map((entry) => entry.subject).join(" ")).toContain("b: edit the same line");
  // main is as it was
  expect(await readFile(join(base, "server.ts"), "utf8")).toBe("line1 from b\nline2\nline3\n");
  expect(git(base, "status", "--porcelain").trim()).toBe("");
});

it("returns the work before it removes a worktree, and keeps the worktree when it cannot", async () => {
  const { base } = await repo();
  const name = `rel-${Date.now()}`;
  const made = await createWorktree({ basePath: base, targetPath: join(tmpdir(), `lp-rl-${Date.now()}`, "wt"), name });
  await writeFile(join(made.path!, "wip.ts"), "half done\n");
  const releaseDir = join(tmpdir(), `lp-released-${Date.now()}`);
  const removed = await removeLaneWorktree({ basePath: base, worktreePath: made.path!, releaseDir });
  expect(removed.removed).toBe(true);
  expect(removed.saved).toMatchObject({ status: "saved", dirty: 1 });
  expect(await readFile(join(releaseDir, `${name}.patch`), "utf8")).toContain("half done");
  expect(await exists(made.path!)).toBe(false);
  await mkdir(releaseDir, { recursive: true });
});
