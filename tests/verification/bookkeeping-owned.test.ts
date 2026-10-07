import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { integrateWorktree } from "../../src/verification/git-integrate";

// Bug 3 (review 2026-10-07): the merge reset every bookkeeping path to main's version, so a task whose expected output
// is `.agents/reports/audit.md` was accepted and the file was dropped silently.
describe("a bookkeeping file the task owns is merged", () => {
  let base: string;
  let wt: string;

  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
    return res.stdout.trim();
  };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "lp-owned-bk-base-"));
    wt = `${base}-wt`;
    git(base, "init", "-b", "main");
    git(base, "config", "user.name", "Test Committer");
    git(base, "config", "user.email", "test@example.com");
    await mkdir(join(base, ".agents"), { recursive: true });
    await writeFile(join(base, ".agents/PROGRESS.md"), "main progress v1\n");
    await writeFile(join(base, "main.ts"), "export const main = 1;\n");
    git(base, "add", "-A");
    git(base, "commit", "-m", "initial");
    git(base, "worktree", "add", "-b", "lane/audit", wt, "HEAD");
  });

  afterEach(async () => {
    try { git(base, "worktree", "remove", "--force", wt); } catch {}
    await rm(base, { recursive: true, force: true }).catch(() => {});
    await rm(wt, { recursive: true, force: true }).catch(() => {});
  });

  const writeAudit = async () => {
    await mkdir(join(wt, ".agents/reports"), { recursive: true });
    await writeFile(join(wt, ".agents/reports/audit.md"), "# Audit\nfindings\n");
    await writeFile(join(wt, ".agents/PROGRESS.md"), "branch progress, a hook wrote it\n");
    await writeFile(join(wt, "feature.ts"), "export const feature = 1;\n");
  };

  it("keeps the owned report and still settles the hook-written PROGRESS.md to main's", async () => {
    await writeAudit();
    git(wt, "add", "-A", "-f");
    git(wt, "commit", "-m", "feat: audit");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "audit", ownsPaths: [".agents/reports/audit.md", "feature.ts"] });

    expect(res.status).toBe("merged");
    expect(await readFile(join(base, ".agents/reports/audit.md"), "utf8")).toBe("# Audit\nfindings\n");
    expect(await readFile(join(base, "feature.ts"), "utf8")).toBe("export const feature = 1;\n");
    expect(await readFile(join(base, ".agents/PROGRESS.md"), "utf8")).toBe("main progress v1\n");
  });

  it("drops the same file when the task does not own it (a hook's report)", async () => {
    await writeAudit();
    git(wt, "add", "-A", "-f");
    git(wt, "commit", "-m", "feat: audit");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "audit", ownsPaths: ["feature.ts"] });

    expect(res.status).toBe("merged");
    expect(git(base, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).not.toContain(".agents/reports/audit.md");
    expect(await readFile(join(base, "feature.ts"), "utf8")).toBe("export const feature = 1;\n");
  });

  it("adds an owned file that the repository's info/exclude hides (activation excludes .agents/reports/), so it is not lost with the worktree", async () => {
    await writeFile(join(base, ".git/info/exclude"), "**/.agents/reports/\n", { flag: "a" });
    await writeAudit();
    // Uncommitted: git add -A alone would skip the excluded report.
    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "audit", ownsPaths: [".agents/reports/audit.md", "feature.ts"], removeWorktree: true });

    expect(res.status).toBe("merged");
    expect(await readFile(join(base, ".agents/reports/audit.md"), "utf8")).toBe("# Audit\nfindings\n");
    expect(await readFile(join(base, ".agents/PROGRESS.md"), "utf8")).toBe("main progress v1\n");
  });

  it("never takes machine-written run receipts as the task's work, even under a broad owns pattern", async () => {
    await mkdir(join(wt, ".agents/runs/lprun_1"), { recursive: true });
    await writeFile(join(wt, ".agents/runs/lprun_1/receipt.json"), "{}\n");
    await writeFile(join(wt, "feature.ts"), "export const feature = 1;\n");
    git(wt, "add", "-A", "-f");
    git(wt, "commit", "-m", "feat: receipts");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "x", ownsPaths: [".agents", "feature.ts", "**"] });

    expect(res.status).toBe("merged");
    expect(git(base, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).not.toContain(".agents/runs/lprun_1/receipt.json");
  });
});
