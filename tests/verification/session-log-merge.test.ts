import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { integrateWorktree } from "../../src/rooms/verification/git-integrate";

// Deploy drill 2026-10-29 14:27 (parallel3): Lane Stack's session ledger hook writes .agents/session-log/ in every session's folder.
// The PM's and the helpers' sessions left it untracked in the base checkout, the claude-code writers' sessions committed their own
// in the worktree, and all three finished tasks waited «for uncommitted edits» that nobody would ever commit.
describe("a merge when the base and the writer both hold a session log the hooks wrote", () => {
  let base: string;
  let wt: string;
  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
    return res.stdout.trim();
  };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "lp-session-log-base-"));
    wt = join(await mkdtemp(join(tmpdir(), "lp-session-log-wt-")), "wt");
    git(base, "init", "-b", "main");
    git(base, "config", "user.name", "Test Committer");
    git(base, "config", "user.email", "test@example.com");
    await writeFile(join(base, "README.md"), "sandbox\n");
    git(base, "add", "-A");
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

  it("merges the writer's work and leaves the base's session log alone", async () => {
    await mkdir(join(base, ".agents/session-log/2026-10-29"), { recursive: true });
    await writeFile(join(base, ".agents/session-log/INDEX.md"), "# Session log\n- pm session\n");
    await writeFile(join(base, ".agents/session-log/2026-10-29/142742-agent-pm.md"), "pm\n");
    await mkdir(join(wt, ".agents/session-log/2026-10-29"), { recursive: true });
    await mkdir(join(wt, "notes"), { recursive: true });
    await writeFile(join(wt, "notes/a.md"), "# note a\n");
    await writeFile(join(wt, ".agents/session-log/INDEX.md"), "# Session log\n- writer session\n");
    await writeFile(join(wt, ".agents/session-log/2026-10-29/142720-agent-writer.md"), "writer\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "drill a: one note");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "drill a" });

    expect(res, JSON.stringify(res)).toMatchObject({ status: "merged" });
    expect(await readFile(join(base, "notes/a.md"), "utf8")).toBe("# note a\n");
    expect(await readFile(join(base, ".agents/session-log/INDEX.md"), "utf8")).toBe("# Session log\n- pm session\n");
  });
});
