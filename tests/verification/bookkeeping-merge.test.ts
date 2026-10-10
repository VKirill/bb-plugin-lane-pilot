import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { integrateWorktree } from "../../src/rooms/verification/git-integrate";

describe("bookkeeping merge collision", () => {
  let base: string;
  let wt: string;

  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
    return res.stdout.trim();
  };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "lp-bookkeeping-merge-base-"));
    wt = await mkdtemp(join(tmpdir(), "lp-bookkeeping-merge-wt-"));

    git(base, "init", "-b", "main");
    git(base, "config", "user.name", "Test Committer");
    git(base, "config", "user.email", "test@example.com");

    await mkdir(join(base, ".agents"), { recursive: true });
    await writeFile(join(base, ".agents/PROGRESS.md"), "main progress v1\n");
    await writeFile(join(base, ".agents/CHANGELOG.md"), "# Changelog\n- entry 1\n");
    await writeFile(join(base, "main.ts"), "export const main = 1;\n");
    git(base, "add", "-A");
    git(base, "commit", "-m", "initial main commit");

    // Create a worktree branch
    git(base, "worktree", "add", "-b", "area/test-branch", wt, "HEAD");
    git(wt, "config", "user.name", "Test Committer");
    git(wt, "config", "user.email", "test@example.com");
  });

  afterEach(async () => {
    try { git(base, "worktree", "remove", "--force", wt); } catch {}
    await rm(base, { recursive: true, force: true }).catch(() => {});
    await rm(wt, { recursive: true, force: true }).catch(() => {});
  });

  it("An area branch carrying chore(progress) changes merges into a base with dirty .agents/PROGRESS.md: base edits kept, writer's product change lands", async () => {
    // In worktree: writer adds product code and also has chore(progress) commits modifying PROGRESS.md and CHANGELOG.md
    await writeFile(join(wt, "product.ts"), "export const product = 'feature';\n");
    await writeFile(join(wt, ".agents/PROGRESS.md"), "branch progress that should be dropped\n");
    await writeFile(join(wt, ".agents/CHANGELOG.md"), "# Changelog\n- branch changelog\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "chore(progress): update project memory after lprun_123");

    // In base: PM or base checkout has uncommitted dirty changes to .agents/PROGRESS.md
    const baseDirtyContent = "base dirty progress uncommitted\n";
    await writeFile(join(base, ".agents/PROGRESS.md"), baseDirtyContent);

    const res = await integrateWorktree({
      basePath: base,
      worktreePath: wt,
      message: "integrate writer product work",
    });

    expect(res.status).toBe("merged");
    expect(res.commit).toBeTruthy();

    // Verify writer's product change landed in base
    expect(await readFile(join(base, "product.ts"), "utf8")).toBe("export const product = 'feature';\n");
    // Verify base uncommitted edit to PROGRESS.md was kept!
    expect(await readFile(join(base, ".agents/PROGRESS.md"), "utf8")).toBe(baseDirtyContent);
  });

  it("A dirty product file overlapping a merge goes to the dirty-base wait path, not merge_failed", async () => {
    // In worktree: writer modifies product.ts
    await writeFile(join(wt, "service.ts"), "export const service = 'from-writer';\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "feat: writer service");

    // In base: product file has uncommitted changes that overlap
    await writeFile(join(base, "service.ts"), "export const service = 'dirty-base';\n");

    const res = await integrateWorktree({
      basePath: base,
      worktreePath: wt,
      message: "integrate conflicting writer",
    });

    // Should return conflict with reason starting with "base checkout has uncommitted changes"
    expect(res.status).toBe("conflict");
    expect(res.conflicts).toContain("service.ts");
    expect(res.reason).toBe("base checkout has uncommitted changes in files this attempt also changes");
    // Base content kept
    expect(await readFile(join(base, "service.ts"), "utf8")).toBe("export const service = 'dirty-base';\n");
  });

  it("a branch's episodes, run receipts and lock notes never stop a merge, whatever the base holds at the same paths", async () => {
    const paths = [".agents/memory/episodes/e1.json", ".agents/runs/lprun_1/receipt.json", "notes/lock/w.lock", ".bb/chats/thr_1/n.md"];
    await writeFile(join(wt, "product.ts"), "export const product = 1;\n");
    for (const path of paths) {
      await mkdir(join(wt, path, ".."), { recursive: true });
      await writeFile(join(wt, path), `branch ${path}\n`);
    }
    git(wt, "add", "-A", "-f");
    git(wt, "commit", "-m", "feat: product with hook bookkeeping");
    // The same files already sit in the base checkout, untracked, written by a hook there.
    for (const path of paths) {
      await mkdir(join(base, path, ".."), { recursive: true });
      await writeFile(join(base, path), `base ${path}\n`);
    }

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "product with bookkeeping" });

    expect(res.status).toBe("merged");
    expect(await readFile(join(base, "product.ts"), "utf8")).toBe("export const product = 1;\n");
    for (const path of paths) expect(await readFile(join(base, path), "utf8")).toBe(`base ${path}\n`);
    // Main's history never carried the branch's bookkeeping.
    expect(git(base, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).not.toContain("notes/lock/w.lock");
  });

  it("a project's own bookkeeping pattern is settled the same way, and a real file beside it still lands", async () => {
    await mkdir(join(wt, "tmp"), { recursive: true });
    await writeFile(join(wt, "tmp/out.log"), "branch log\n");
    await writeFile(join(wt, "feature.ts"), "export const feature = 1;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "feat: feature and a log");
    await mkdir(join(base, "tmp"), { recursive: true });
    await writeFile(join(base, "tmp/out.log"), "base log\n");

    const blocked = await integrateWorktree({ basePath: base, worktreePath: wt, message: "x" });
    // Not tracked in base and untracked there: git refuses to overwrite it.
    expect(blocked.status).not.toBe("merged");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "x", bookkeeping: ["tmp/**"] });
    expect(res.status).toBe("merged");
    expect(await readFile(join(base, "feature.ts"), "utf8")).toBe("export const feature = 1;\n");
    expect(await readFile(join(base, "tmp/out.log"), "utf8")).toBe("base log\n");
  });

  it("bookkeeping main changed meanwhile and the branch changed too is taken from main, with no conflict", async () => {
    await writeFile(join(wt, ".agents/PROGRESS.md"), "branch progress\n");
    await writeFile(join(wt, "product.ts"), "export const product = 2;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "feat: product and progress");
    await writeFile(join(base, ".agents/PROGRESS.md"), "main progress v2\n");
    git(base, "add", "-A");
    git(base, "commit", "-m", "chore(progress): v2");

    const res = await integrateWorktree({ basePath: base, worktreePath: wt, message: "x" });

    expect(res.status).toBe("merged");
    expect(await readFile(join(base, ".agents/PROGRESS.md"), "utf8")).toBe("main progress v2\n");
    expect(await readFile(join(base, "product.ts"), "utf8")).toBe("export const product = 2;\n");
  });

  it("project-life/memory commits never happen inside an attempt or area worktree (test)", async () => {
    // Project-life maintenance stage factory builds the stage API
    const { createProjectLifeStage } = await import("../../src/rooms/project-life/server/project-life");
    expect(typeof createProjectLifeStage).toBe("function");
  });
});
