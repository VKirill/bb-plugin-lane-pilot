import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, integrateWorktree, syncWorktree } from "../../src/rooms/verification/git-integrate";
import { candidateCommand, candidatePath, createCandidates } from "../../src/rooms/phase/server/candidate";

// SMA p6_prepared → p6_merge on real git: the phase's pieces merge into phase/<id> in a worktree inside the checkout's .git, main stays
// as it was until the accepted branch lands, and a main that moved or conflicts is found before the landing.
describe("the phase candidate on a real repository", () => {
  let base: string;
  let wts: string;
  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
    return res.stdout.trim();
  };
  const sh = (cwd: string, script: string) => spawnSync("sh", ["-c", script], { cwd, encoding: "utf8" });
  const commit = async (cwd: string, file: string, text: string) => { await writeFile(join(cwd, file), text); git(cwd, "add", "-A"); git(cwd, "commit", "-qm", `edit ${file}`); };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "lp-candidate-base-"));
    wts = await mkdtemp(join(tmpdir(), "lp-candidate-wts-"));
    git(base, "init", "-q", "-b", "main");
    git(base, "config", "user.name", "Test Committer");
    git(base, "config", "user.email", "test@example.com");
    await commit(base, "README.md", "sandbox\n");
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
    await rm(wts, { recursive: true, force: true }).catch(() => {});
  });

  it("collects a piece on the phase branch, keeps main and git status clean, and lands the verified branch [sma:p6_merge]", async () => {
    const made = sh(base, candidateCommand("ph_t1"));
    expect(made.status).toBe(0);
    const tree = candidatePath(base, "ph_t1");
    expect(made.stdout.trim()).toBe(git(base, "rev-parse", "HEAD"));
    expect(git(base, "status", "--porcelain", "--untracked-files=all")).toBe("");
    // A second issue finds it made.
    expect(sh(base, candidateCommand("ph_t1")).status).toBe(0);

    const attempt = await createWorktree({ basePath: tree, targetPath: join(wts, "att1", "repo"), name: "att1" });
    expect(attempt.status).toBe("ready");
    git(attempt.path!, "config", "user.name", "Writer"); git(attempt.path!, "config", "user.email", "w@example.com");
    await writeFile(join(attempt.path!, "piece.txt"), "the piece\n");
    const merged = await integrateWorktree({ basePath: tree, worktreePath: attempt.path!, message: "piece a", removeWorktree: true });
    expect(merged.status).toBe("merged");
    expect(await readFile(join(tree, "piece.txt"), "utf8")).toBe("the piece\n");
    expect(sh(base, "test -e piece.txt").status).not.toBe(0);
    expect(git(base, "log", "-1", "--format=%s")).toBe("edit README.md");

    const verified = git(tree, "rev-parse", "HEAD");
    expect(await syncWorktree({ basePath: base, worktreePath: tree })).toMatchObject({ status: "up-to-date" });
    const landed = await integrateWorktree({ basePath: base, worktreePath: tree, message: "land phase/ph_t1", committedOnly: true });
    expect(landed.status).toBe("merged");
    expect(await readFile(join(base, "piece.txt"), "utf8")).toBe("the piece\n");
    expect(git(base, "merge-base", "--is-ancestor", verified, "HEAD")).toBe("");
  });

  it("finds a main that moved since the verdict, and a main that conflicts, before anything lands [sma:p6_stale]", async () => {
    sh(base, candidateCommand("ph_t2"));
    const tree = candidatePath(base, "ph_t2");
    git(tree, "config", "user.name", "Writer"); git(tree, "config", "user.email", "w@example.com");
    await commit(tree, "piece.txt", "phase work\n");
    const verified = git(tree, "rev-parse", "HEAD");
    await commit(base, "other.txt", "work outside the phase\n");
    const moved = await syncWorktree({ basePath: base, worktreePath: tree });
    expect(moved.status).toBe("synced");
    expect(moved.head).not.toBe(verified);
    expect(sh(base, "test -e piece.txt").status).not.toBe(0);

    await commit(base, "piece.txt", "main wrote the same file\n");
    await commit(tree, "piece.txt", "phase rewrote it\n");
    const clash = await syncWorktree({ basePath: base, worktreePath: tree });
    expect(clash).toMatchObject({ status: "conflict" });
    expect(git(tree, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(await readFile(join(base, "piece.txt"), "utf8")).toBe("main wrote the same file\n");
  });

  it("refuses a checkout whose .git is a file: no phase branch there", async () => {
    const linked = join(wts, "linked");
    git(base, "worktree", "add", "-q", "-b", "other", linked, "HEAD");
    const made = sh(linked, candidateCommand("ph_t3"));
    expect(made.status).toBe(3);
    expect(made.stderr).toMatch(/not a folder/);
  });

  // SMA audit of C-03: main could move between the candidate taking it in and the merge; the merge then was not the verified tree.
  it("[sma:k_d_exec_steps] a landing refuses when main moved after the candidate took it in", async () => {
    expect(sh(base, candidateCommand("ph_t3")).status).toBe(0);
    const tree = candidatePath(base, "ph_t3");
    await commit(tree, "hud.ts", "export const hud = 1;\n");
    expect((await syncWorktree({ basePath: base, worktreePath: tree })).status).toBe("up-to-date");
    const verified = git(tree, "rev-parse", "HEAD");
    await commit(base, "other.ts", "export const other = 1;\n");
    const mainBefore = git(base, "rev-parse", "HEAD");
    const refused = await integrateWorktree({ basePath: base, worktreePath: tree, message: "land", committedOnly: true, baseInHead: true });
    expect(refused.status).toBe("failed");
    expect(refused.reason).toContain("base moved since the candidate took it in");
    expect(git(base, "rev-parse", "HEAD")).toBe(mainBefore);
    expect(git(tree, "rev-parse", "HEAD")).toBe(verified);
  });

  // SMA audit R-03: a commit made on the candidate after its head was read and synced landed on main unreviewed.
  it("[sma:k_d_exec_steps] a landing refuses a candidate that got a commit after it was verified", async () => {
    expect(sh(base, candidateCommand("ph_race")).status).toBe(0);
    const tree = candidatePath(base, "ph_race");
    await commit(tree, "verified.txt", "approved bytes\n");
    const verified = git(tree, "rev-parse", "HEAD");
    const mainBefore = git(base, "rev-parse", "HEAD");
    const host = { call: async (method: string, input: any) => {
      if (method === "runCommand") { const ran = sh(input.cwd, input.command); return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr }; }
      if (method === "gitSyncWorktree") return syncWorktree(input);
      if (method === "gitIntegrate") { await commit(tree, "unreviewed.txt", "not in the approved commit\n"); return integrateWorktree(input); }
      throw new Error(`unexpected ${method}`);
    } };
    const result = await createCandidates(host, "h", () => {}).land(base, { path: tree, startSha: mainBefore }, verified, "land phase", []);
    expect(result.state).toBe("moved");
    expect(git(base, "rev-parse", "HEAD")).toBe(mainBefore);
    expect(sh(base, "test -f unreviewed.txt").status).not.toBe(0);
  });

  // Live 2026-11-11: Lane Pilot's own VERIFICATION.md and changelog line on main sent every accepted phase back to verification.
  const realHost = { call: async (method: string, input: any) => {
    if (method === "runCommand") { const ran = sh(input.cwd, input.command); return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr }; }
    if (method === "gitSyncWorktree") return syncWorktree(input);
    if (method === "gitIntegrate") return integrateWorktree(input);
    throw new Error(`unexpected ${method}`);
  } };
  const withRecords = async (id: string) => {
    expect(sh(base, candidateCommand(id)).status).toBe(0);
    const tree = candidatePath(base, id);
    const startSha = git(base, "rev-parse", "HEAD");
    await commit(tree, "verified.txt", "approved bytes\n");
    sh(base, `mkdir -p .agents/phases/${id}`);
    await commit(base, `.agents/phases/${id}/VERIFICATION.md`, "# verification\n");
    await commit(base, ".agents/CHANGELOG.md", "- a line\n");
    return { tree: { path: tree, startSha }, verified: git(tree, "rev-parse", "HEAD") };
  };

  it("main moved by Lane Pilot's own records only: the verified package lands, records and all", async () => {
    const { tree, verified } = await withRecords("ph_rec");
    const result = await createCandidates(realHost, "h", () => {}).land(base, tree, verified, "land phase", [], [".agents/phases/ph_rec/**"]);
    expect(result).toMatchObject({ state: "landed", records: { paths: [".agents/CHANGELOG.md", ".agents/phases/ph_rec/VERIFICATION.md"] } });
    expect(await readFile(join(base, "verified.txt"), "utf8")).toBe("approved bytes\n");
    expect(git(base, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("main moved by a record and one other file, or by a code file renamed into the records folder: verified again, nothing lands", async () => {
    const first = await withRecords("ph_mix");
    await commit(base, "other.txt", "someone's work\n");
    const mainBefore = git(base, "rev-parse", "HEAD");
    const mixed = await createCandidates(realHost, "h", () => {}).land(base, first.tree, first.verified, "land phase", [], [".agents/phases/ph_mix/**"]);
    expect(mixed.state).toBe("moved");
    expect(git(base, "rev-parse", "HEAD")).toBe(mainBefore);

    expect(sh(base, candidateCommand("ph_ren")).status).toBe(0);
    const tree = candidatePath(base, "ph_ren");
    const startSha = git(base, "rev-parse", "HEAD");
    await commit(tree, "verified.txt", "second approved bytes\n");
    sh(base, "mkdir -p .agents/phases/ph_ren && git mv README.md .agents/phases/ph_ren/README.md && git commit -qm 'move a file into the records folder'");
    const renamed = await createCandidates(realHost, "h", () => {}).land(base, { path: tree, startSha }, git(tree, "rev-parse", "HEAD"), "land phase", [], [".agents/phases/ph_ren/**"]);
    expect(renamed.state).toBe("moved");
  });
});
