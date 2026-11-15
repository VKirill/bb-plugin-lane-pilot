import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** Paths whose chmod the OS refuses in this file; real files otherwise (EXT05 review: failures must not read as done). */
const refused = new Set<string>();
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, chmod: async (path: string, mode: number) => {
    if ([...refused].some((suffix) => String(path).endsWith(suffix))) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return fs.chmod(path, mode);
  } };
});

const { applyLaneOwnsBarrier, applyOwnsBarrier, liftOwnsBarrier } = await import("../src/rooms/verification/git-integrate");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const modeOf = async (dir: string, path: string) => (await stat(join(dir, path))).mode & 0o777;
// A linked worktree names its git path absolute, a main checkout relative: resolve takes both.
const statePath = (dir: string) => resolve(dir, git(dir, "rev-parse", "--git-path", "lane-pilot-owns-barrier.json").trim());
const recorded = async (dir: string) => JSON.parse(await readFile(statePath(dir), "utf8")) as Array<{ path: string; mode: number }>;

async function laneWorktree(files: string[]) {
  const laneRoot = await mkdtemp(join(tmpdir(), "lp-lane-root-"));
  const repo = await mkdtemp(join(tmpdir(), "lp-owns-fail-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  for (const file of files) {
    await mkdir(join(repo, file, ".."), { recursive: true });
    await writeFile(join(repo, file), `${file}\n`);
  }
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  const worktree = join(laneRoot, "wt");
  git(repo, "worktree", "add", "-q", "-b", "lane/t", worktree);
  for (const file of files) await chmod(join(worktree, file), 0o640);
  return { laneRoot, worktree };
}

describe("owns barrier failures are reported, never read as applied (EXT05 review)", () => {
  it("a file the OS refuses to lock fails the in-place sync, and its record with the original mode stays for a lift", async () => {
    const { laneRoot, worktree } = await laneWorktree(["src/a.ts", "src/b.ts", "src/c.ts"]);
    refused.add("src/c.ts");
    try {
      await expect(applyLaneOwnsBarrier({ laneRoot, worktreePath: worktree, ownsPaths: ["src/a.ts"], neverTouch: [] })).rejects.toThrow(/src\/c\.ts/);
      // The bind-time barrier reads the same outcome as data, not as a thrown pass.
      expect((await applyOwnsBarrier({ worktreePath: worktree, ownsPaths: ["src/a.ts"], neverTouch: [] })).failed).toEqual(["src/c.ts"]);
    } finally { refused.clear(); }
    expect(await modeOf(worktree, "src/b.ts")).toBe(0o440);
    expect(await recorded(worktree)).toEqual([{ path: "src/b.ts", mode: 0o640 }, { path: "src/c.ts", mode: 0o640 }]);
    expect((await liftOwnsBarrier(worktree)).restored).toBe(2);
    expect(await modeOf(worktree, "src/b.ts")).toBe(0o640);
  });

  it("a widened file the OS refuses to give back fails the sync and stays recorded", async () => {
    const { laneRoot, worktree } = await laneWorktree(["src/a.ts", "src/b.ts"]);
    await applyLaneOwnsBarrier({ laneRoot, worktreePath: worktree, ownsPaths: ["src/a.ts"], neverTouch: [] });
    refused.add("src/b.ts");
    try {
      await expect(applyLaneOwnsBarrier({ laneRoot, worktreePath: worktree, ownsPaths: ["src/a.ts", "src/b.ts"], neverTouch: [] })).rejects.toThrow(/src\/b\.ts/);
    } finally { refused.clear(); }
    expect(await modeOf(worktree, "src/b.ts")).toBe(0o440);
    expect(await recorded(worktree)).toEqual([{ path: "src/b.ts", mode: 0o640 }]);
  });

  it("a lift whose restore is refused keeps that record; a deleted file's record goes; a corrupt state is an error that loses nothing", async () => {
    const { worktree } = await laneWorktree(["src/a.ts", "src/b.ts", "src/c.ts"]);
    await applyOwnsBarrier({ worktreePath: worktree, ownsPaths: ["src/a.ts"], neverTouch: [] });
    await rm(join(worktree, "src/c.ts"));
    refused.add("src/b.ts");
    try { expect((await liftOwnsBarrier(worktree)).restored).toBe(0); } finally { refused.clear(); }
    expect(await recorded(worktree)).toEqual([{ path: "src/b.ts", mode: 0o640 }]);
    expect((await liftOwnsBarrier(worktree)).restored).toBe(1);
    expect(await modeOf(worktree, "src/b.ts")).toBe(0o640);

    await applyOwnsBarrier({ worktreePath: worktree, ownsPaths: ["src/a.ts"], neverTouch: [] });
    await writeFile(statePath(worktree), "{not json");
    await expect(liftOwnsBarrier(worktree)).rejects.toThrow();
    await expect(applyOwnsBarrier({ worktreePath: worktree, ownsPaths: ["src/a.ts", "src/b.ts"], neverTouch: [] })).rejects.toThrow();
    expect(await readFile(statePath(worktree), "utf8")).toBe("{not json");
    expect(await modeOf(worktree, "src/b.ts")).toBe(0o440);
  });
});
