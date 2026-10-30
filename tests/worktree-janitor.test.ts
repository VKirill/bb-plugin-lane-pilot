import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/storage/database";
import { sweepLaneWorktrees } from "../src/rooms/verification/worktree-janitor";
import { worktreeJanitor } from "../src/rooms/host-worker/host-handlers";
import { runWorktreeJanitor } from "../src/rooms/stability/server/worktree-janitor";
import { cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees } from "../src/rooms/runs/server";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

/** A real repo in tmp with one linked Lane Pilot worktree at root/<group>/<repo>. */
async function fixture(name = "repo") {
  const dir = await mkdtemp(join(tmpdir(), "lp-janitor-test-"));
  const base = join(dir, "base");
  const root = join(dir, "worktrees");
  await mkdir(base, { recursive: true });
  git(base, ["init", "-q", "-b", "main"]);
  git(base, ["config", "user.email", "t@t"]);
  git(base, ["config", "user.name", "t"]);
  writeFileSync(join(base, "a.txt"), "a");
  git(base, ["add", "."]);
  git(base, ["commit", "-qm", "init"]);
  const top = join(root, name, "repo");
  git(base, ["worktree", "add", "-q", "-b", `lane/${name}`, top, "HEAD"]);
  return { dir, base, root, top };
}
describe("the worktree janitor", () => {
  it("removes a merged clean copy with its lane branch and the empty group folder", async () => {
    const { base, root, top } = await fixture("done-x");
    const out = await sweepLaneWorktrees({ root, protectedPaths: new Set(), graceMs: 0 });
    expect(out.removed).toEqual([top]);
    expect(existsSync(top)).toBe(false);
    expect(existsSync(join(root, "done-x"))).toBe(false);
    expect(git(base, ["branch", "--list", "lane/*"])).toBe("");
  });

  it("keeps a copy with uncommitted edits and names it", async () => {
    const { root, top } = await fixture("dirty-x");
    writeFileSync(join(top, "a.txt"), "changed");
    const out = await sweepLaneWorktrees({ root, protectedPaths: new Set(), graceMs: 0 });
    expect(out.removed).toEqual([]);
    expect(out.kept.map((row) => row.reason)).toEqual(["uncommitted edits"]);
    expect(existsSync(top)).toBe(true);
  });

  it("keeps a copy whose commits sit on no other branch or remote", async () => {
    const { root, top } = await fixture("unique-x");
    writeFileSync(join(top, "b.txt"), "b");
    git(top, ["add", "."]);
    git(top, ["commit", "-qm", "unique"]);
    const out = await sweepLaneWorktrees({ root, protectedPaths: new Set(), graceMs: 0 });
    expect(out.removed).toEqual([]);
    expect(out.kept[0]?.reason).toContain("commits");
    expect(existsSync(top)).toBe(true);
  });

  it("never touches a copy an open attempt still holds, or one younger than the grace", async () => {
    const { root, top } = await fixture("held-x");
    const held = await sweepLaneWorktrees({ root, protectedPaths: new Set([await realpath(top)]), graceMs: 0 });
    expect(held.removed).toEqual([]);
    const { root: root2, top: top2 } = await fixture("young-x");
    const young = await sweepLaneWorktrees({ root: root2, protectedPaths: new Set(), graceMs: 3_600_000 });
    expect(young.removed).toEqual([]);
    expect(young.kept).toEqual([]);
    expect(existsSync(top2)).toBe(true);
  });

  it("removes a folder with no .git inside the worktree root", async () => {
    const { root } = await fixture();
    const orphan = join(root, "orphan-1", "repo");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "left.txt"), "x");
    const out = await sweepLaneWorktrees({ root, protectedPaths: new Set(), graceMs: 0 });
    expect(out.removed).toContain(orphan);
    expect(existsSync(orphan)).toBe(false);
  });

  it("sweeps only Lane Pilot's tmp prefixes older than a day", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "lp-janitor-tmp-"));
    const old = join(tmp, "lane-pilot-sandbox-dead");
    const young = join(tmp, "lp-gate-base-live");
    const other = join(tmp, "someone-else-dir");
    for (const path of [old, young, other]) await mkdir(path, { recursive: true });
    await utimes(old, new Date(Date.now() - 26 * 3_600_000), new Date(Date.now() - 26 * 3_600_000));
    const out = await sweepLaneWorktrees({ root: join(tmp, "nowhere"), protectedPaths: new Set(), graceMs: 0, tmpDir: tmp });
    expect(out.tmpRemoved).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("runs through the real host-worker handler", async () => {
    // The handler sweeps laneWorktreeRoot() = $HOME/.lane-pilot/worktrees; a fake HOME points it at the fixture, real wiring.
    const { base, root, top, dir } = await fixture("handler-x");
    const laneRoot = join(dir, ".lane-pilot", "worktrees");
    await mkdir(laneRoot, { recursive: true });
    execFileSync("mv", [join(root, "handler-x"), join(laneRoot, "handler-x")]);
    const movedTop = join(laneRoot, "handler-x", "repo");
    vi.stubEnv("HOME", dir);
    try {
      const out = await worktreeJanitor({ requestedHostId: "test-host", protectedPaths: [], graceMs: 0 }, {} as never);
      expect(out.hostId).toBe("test-host");
      expect(out.removed).toContain(movedTop);
      expect(existsSync(movedTop)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("cleanup.worktrees=off touches nothing", async () => {
    const bb = createFakePluginHost({ pluginId: "lane-pilot" }).bb;
    const db = openDatabase(bb);
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES('*','','cleanup.worktrees','\"off\"',1,0)").run();
    let calls = 0;
    const ctx = {
      bb, db, log: () => undefined, isDisposed: () => false,
      host: { call: async () => { calls++; return {}; } },
    } as never;
    const out = await runWorktreeJanitor(ctx, { cleanupStickyLaneWorktrees, cleanupFinishedAttemptEnvironments });
    expect(out).toEqual({ removed: 0, freedBytes: 0, kept: 0 });
    expect(calls).toBe(0);
  });
});
