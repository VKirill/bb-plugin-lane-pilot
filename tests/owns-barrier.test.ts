import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isOwnershipNoise } from "@lane-pilot/settings-catalog";
import { applyLaneOwnsBarrier, applyOwnsBarrier, liftOwnsBarrier } from "../src/rooms/verification/git-integrate";
import { dropSatellites, satelliteOf } from "../src/rooms/contracts/ownership";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

async function seededRepo(files: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "lp-owns-barrier-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  for (const file of files) {
    await writeFile(join(dir, file), `${file}\n`, { flag: "w" }).catch(async () => {
      await execFileSync("mkdir", ["-p", join(dir, file.split("/").slice(0, -1).join("/"))]);
      await writeFile(join(dir, file), `${file}\n`);
    });
  }
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
  return dir;
}

describe("owns-paths satellites (F-02)", () => {
  const anchors = ["src/foo.ts", "game/src/match.luau", "packages/i18n/src/keys.ts"];

  it("lets a test and a locale of an owned area pass, keeps other strays as violations", () => {
    const flagged = ["tests/foo.test.ts", "src/foo.test.ts", "game/assets/lang/en.json", "packages/i18n/locales/ru.json", ".cls/catalog.json", "yaml.py", "docs/guide.md"];
    const dropped = dropSatellites(flagged, anchors);
    expect(dropped.unowned).toEqual([".cls/catalog.json", "docs/guide.md", "yaml.py"]);
    expect(dropped.satellites).toEqual(["game/assets/lang/en.json", "packages/i18n/locales/ru.json", "src/foo.test.ts", "tests/foo.test.ts"]);
  });

  it("needs an owned change: a stray test with no anchor stays a violation", () => {
    expect(dropSatellites(["tests/foo.test.ts"], []).unowned).toEqual(["tests/foo.test.ts"]);
    expect(satelliteOf("tests/foo.test.ts", ["docs/other.ts"])).toBe(false);
  });

  it("treats build output wider than tool caches as ownership noise, no anchor needed", () => {
    for (const path of ["packages/app/dist/index.js", "game/build/out.bin", "pkg/target/bin/app", "web/.next/static/x.js", "app/coverage/lcov.info", "src/module.tsbuildinfo"])
      expect(isOwnershipNoise(path)).toBe(true);
    for (const path of ["src/build/helper.ts", "tools/target/run.sh"])
      expect(isOwnershipNoise(path)).toBe(true);
  });
});

describe("owns-paths barrier (F-01)", () => {
  it("locks tracked files outside the contract, frees satellites, restores modes on lift", async () => {
    const dir = await seededRepo(["src/a.ts", "src/b.ts", "tests/a.test.ts", "docs/en.json", "docs/guide.md"]);
    const locked = await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts"], neverTouch: [] });
    // src/b.ts (unowned), docs/en.json (locale without an owned anchor in its area), docs/guide.md are locked;
    // src/a.ts is owned, tests/a.test.ts is a satellite of src/a.ts — both stay writable.
    expect(locked.locked).toBe(3);
    await expect(access(join(dir, "src/b.ts"), constants.W_OK)).rejects.toThrow();
    await expect(access(join(dir, "docs/guide.md"), constants.W_OK)).rejects.toThrow();
    await access(join(dir, "src/a.ts"), constants.W_OK);
    await access(join(dir, "tests/a.test.ts"), constants.W_OK);
    const restored = await liftOwnsBarrier(dir);
    expect(restored.restored).toBe(3);
    await access(join(dir, "src/b.ts"), constants.W_OK);
    await access(join(dir, "docs/guide.md"), constants.W_OK);
    // A second lift finds no barrier state and does nothing.
    expect((await liftOwnsBarrier(dir)).restored).toBe(0);
  });

  it("keeps a file a writer never_touches locked even when it looks like a test", async () => {
    const dir = await seededRepo(["src/a.ts", "src/a.test.ts"]);
    const locked = await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts"], neverTouch: ["src/a.test.ts"] });
    expect(locked.locked).toBe(1);
    await expect(access(join(dir, "src/a.test.ts"), constants.W_OK)).rejects.toThrow();
    await liftOwnsBarrier(dir);
  });
});

// EXT05 (layers audit 2026-11-15): owns_paths widened in place told the writer «edit X» while X stayed read-only, and a second
// apply rewrote the state without the files it had locked, so a lift could no longer give them their modes back.
describe("owns barrier follows a changed contract (EXT05)", () => {
  const writable = async (dir: string, file: string) => access(join(dir, file), constants.W_OK).then(() => true, () => false);
  const modeOf = async (dir: string, file: string) => (await stat(join(dir, file))).mode & 0o777;
  // A linked worktree names its git path absolute, a main checkout relative: resolve takes both.
  const statePath = (dir: string) => resolve(dir, git(dir, "rev-parse", "--git-path", "lane-pilot-owns-barrier.json").trim());

  it("unlocks a widened file to its original mode, keeps never_touch and the rest locked, and goes back on rollback", async () => {
    const dir = await seededRepo(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    await chmod(join(dir, "src/b.ts"), 0o640);
    expect(await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts"], neverTouch: ["src/d.ts"] })).toEqual({ locked: 3, unlocked: 0, failed: [] });
    expect(await modeOf(dir, "src/b.ts")).toBe(0o440);

    expect(await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts", "src/b.ts", "src/d.ts"], neverTouch: ["src/d.ts"] })).toEqual({ locked: 0, unlocked: 1, failed: [] });
    expect(await modeOf(dir, "src/b.ts")).toBe(0o640);
    await writeFile(join(dir, "src/b.ts"), "edited by the writer\n");
    expect(await writable(dir, "src/c.ts")).toBe(false);
    expect(await writable(dir, "src/d.ts")).toBe(false); // never_touch wins over owns_paths
    // The same contract again changes nothing.
    expect(await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts", "src/b.ts", "src/d.ts"], neverTouch: ["src/d.ts"] })).toEqual({ locked: 0, unlocked: 0, failed: [] });

    // The turn was not delivered: the old contract's barrier comes back, with b's original mode recorded.
    expect(await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts"], neverTouch: ["src/d.ts"] })).toEqual({ locked: 1, unlocked: 0, failed: [] });
    expect(await writable(dir, "src/b.ts")).toBe(false);
    expect((await liftOwnsBarrier(dir)).restored).toBe(3);
    expect(await modeOf(dir, "src/b.ts")).toBe(0o640);
    expect(await writable(dir, "src/c.ts")).toBe(true);
  });

  it("a pass cut off after recording a file locks it next time with the mode it recorded, never one read from the file again", async () => {
    const dir = await seededRepo(["src/a.ts", "src/b.ts"]);
    await chmod(join(dir, "src/b.ts"), 0o640);
    // What a pass cut off between writing the state and chmod leaves: b is recorded, its mode not changed yet.
    await writeFile(statePath(dir), JSON.stringify([{ path: "src/b.ts", mode: 0o640 }]));
    await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts"], neverTouch: [] });
    expect(await modeOf(dir, "src/b.ts")).toBe(0o440);
    expect((await liftOwnsBarrier(dir)).restored).toBe(1);
    expect(await modeOf(dir, "src/b.ts")).toBe(0o640);
  });

  it("never changes a file outside the worktree that a swapped-in symlink folder points at, on apply or lift", async () => {
    const dir = await seededRepo(["src/a.ts", "lib/x.ts"]);
    const outside = await mkdtemp(join(tmpdir(), "lp-owns-outside-"));
    await writeFile(join(outside, "x.ts"), "not the worktree's\n");
    await chmod(join(outside, "x.ts"), 0o644);
    // An explicit original mode, not the one the umask gave the checkout (0o664 on one host, 0o644 on another).
    await chmod(join(dir, "lib/x.ts"), 0o640);
    await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts"], neverTouch: [] });
    await rm(join(dir, "lib"), { recursive: true, force: true });
    await symlink(outside, join(dir, "lib"));
    await applyOwnsBarrier({ worktreePath: dir, ownsPaths: ["src/a.ts"], neverTouch: [] });
    expect(await modeOf(outside, "x.ts")).toBe(0o644);
    await chmod(join(outside, "x.ts"), 0o600);
    expect((await liftOwnsBarrier(dir)).restored).toBe(0);
    expect(await modeOf(outside, "x.ts")).toBe(0o600);
    // Not restored, so still recorded: the original mode is not lost (EXT05 review).
    expect(JSON.parse(await readFile(statePath(dir), "utf8"))).toEqual([{ path: "lib/x.ts", mode: 0o640 }]);
  });

  it("changes only a linked worktree under the lane root: a checkout elsewhere or a main checkout under it is left alone", async () => {
    const laneRoot = await mkdtemp(join(tmpdir(), "lp-lane-root-"));
    const repo = await seededRepo(["src/a.ts", "src/b.ts"]);
    const worktree = join(laneRoot, "repo", "wt");
    await mkdir(join(laneRoot, "repo"), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "lane/t", worktree);
    const contract = { laneRoot, ownsPaths: ["src/a.ts"], neverTouch: [] };
    expect(await applyLaneOwnsBarrier({ ...contract, worktreePath: worktree })).toEqual({ status: "applied", locked: 1, unlocked: 0 });
    expect(await writable(worktree, "src/b.ts")).toBe(false);
    expect(await applyLaneOwnsBarrier({ ...contract, worktreePath: repo })).toEqual({ status: "not_lane_worktree", locked: 0, unlocked: 0 });
    expect(await writable(repo, "src/b.ts")).toBe(true);
    const mainUnderRoot = join(laneRoot, "main");
    execFileSync("git", ["clone", "-q", repo, mainUnderRoot]);
    expect(await applyLaneOwnsBarrier({ ...contract, worktreePath: mainUnderRoot })).toEqual({ status: "not_lane_worktree", locked: 0, unlocked: 0 });
    expect(await writable(mainUnderRoot, "src/b.ts")).toBe(true);
  });

  const laneWorktree = async () => {
    const laneRoot = await mkdtemp(join(tmpdir(), "lp-lane-root-"));
    const repo = await seededRepo(["src/a.ts", "src/b.ts"]);
    const worktree = join(laneRoot, "wt");
    git(repo, "worktree", "add", "-q", "-b", "lane/t", worktree);
    await chmod(join(worktree, "src/b.ts"), 0o640);
    return { laneRoot, worktree, lock: join(git(worktree, "rev-parse", "--absolute-git-dir").trim(), "lane-pilot-integrate.lock") };
  };

  it("a pass waits for one still holding the worktree's lock (a caller timed out on it) and only then changes modes", async () => {
    const { laneRoot, worktree, lock } = await laneWorktree();
    // What an earlier pass of this process still running leaves: the checkout's lock with its pid.
    await mkdir(lock);
    await writeFile(join(lock, "owner"), `${process.pid}\nowns barrier`);
    const next = applyLaneOwnsBarrier({ laneRoot, worktreePath: worktree, ownsPaths: ["src/a.ts"], neverTouch: [] });
    await new Promise((done) => setTimeout(done, 1_200));
    expect(await modeOf(worktree, "src/b.ts")).toBe(0o640);
    await rm(lock, { recursive: true, force: true });
    expect(await next).toEqual({ status: "applied", locked: 1, unlocked: 0 });
    expect(await modeOf(worktree, "src/b.ts")).toBe(0o440);
    await expect(stat(lock)).rejects.toThrow();
  });

  it("a cancelled request changes nothing and leaves no lock", async () => {
    const { laneRoot, worktree, lock } = await laneWorktree();
    const cancelled = new AbortController();
    cancelled.abort(new Error("request cancelled"));
    await expect(applyLaneOwnsBarrier({ laneRoot, worktreePath: worktree, ownsPaths: ["src/a.ts"], neverTouch: [], signal: cancelled.signal })).rejects.toThrow(/cancelled/);
    expect(await modeOf(worktree, "src/b.ts")).toBe(0o640);
    await expect(stat(statePath(worktree))).rejects.toThrow();
    await expect(stat(lock)).rejects.toThrow();
  });
});
