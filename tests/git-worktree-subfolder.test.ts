import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { worktreeCreateError } from "../src/rooms/writer/server/services/spawn";
import { createWorktree, integrateWorktree, workspaceGitLayout } from "../src/rooms/worktree";
import { gitOwnershipChangedPaths, resolveGitOwnershipBase } from "../src/rooms/verification/git-ownership";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

async function nestedWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "lp-subfolder-"));
  const base = join(root, "main");
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  await writeFile(join(base, "root.ts"), "export {};\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");
  const nested = join(base, "apps", "bot");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "index.ts"), "export {};\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "nested");
  return { root, base, nested };
}

// Worktree-only (decision 2026-10-06): a subfolder chat no longer runs in place; it gets a worktree of the repo.
it("gives a subfolder chat a worktree of its repo, merges the writer's work into main and removes the worktree", async () => {
  const { base, nested } = await nestedWorkspace();
  const target = join(base, "..", "own", "bot");
  const created = await createWorktree({ basePath: nested, targetPath: target, name: "lpattempt_sub" });
  expect(created).toMatchObject({ status: "ready", path: join(target, "apps", "bot"), branch: "lane/lpattempt_sub", reason: null });
  expect(await workspaceGitLayout(created.path!)).toMatchObject({ ok: true, nested: true, prefix: "apps/bot" });
  await writeFile(join(created.path!, "index.ts"), "export const changed = 1;\n");
  const merged = await integrateWorktree({ basePath: nested, worktreePath: created.path!, message: "sub: edit", removeWorktree: true });
  expect(merged.status).toBe("merged");
  expect(await readFile(join(nested, "index.ts"), "utf8")).toBe("export const changed = 1;\n");
  expect(existsSync(target)).toBe(false);
  expect(git(base, "branch", "--list", "lane/lpattempt_sub").trim()).toBe("");
});

it("creates a writer worktree when the chat folder is the git repo root", async () => {
  const { base } = await nestedWorkspace();
  const target = join(base, "..", "own", "main");
  const created = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_root" });
  expect(created).toMatchObject({ status: "ready", path: target, branch: "lane/lpattempt_root", reason: null });
  expect(await workspaceGitLayout(base)).toMatchObject({ ok: true, nested: false, prefix: "" });
});

it("names any worktree creation failure as Lane Pilot's", () => {
  expect(worktreeCreateError("fatal: already exists")).toBe("attempt_worktree_failed:fatal: already exists");
  expect(worktreeCreateError(null)).toBe("attempt_worktree_failed:unknown");
});

it("ownership in a nested folder sees the writer's new and changed files relative to that folder", async () => {
  const { base, nested } = await nestedWorkspace();
  const frozen = await resolveGitOwnershipBase({ projectCwd: nested });
  expect(frozen).toMatchObject({ status: "ready", branch: "main", compareCommitted: false });
  await writeFile(join(nested, "index.ts"), "export const changed = 1;\n");
  await writeFile(join(nested, "new.ts"), "export {};\n");
  await mkdir(join(base, "apps", "other"), { recursive: true });
  await writeFile(join(base, "apps", "other", "skip.ts"), "export {};\n");
  const dirty = await gitOwnershipChangedPaths({ projectCwd: nested, baseSha: null, compareCommitted: false });
  expect(dirty.status).toBe("ready");
  expect(dirty.paths.sort()).toEqual(["index.ts", "new.ts"]);
  git(base, "switch", "-q", "-c", "feature");
  git(base, "add", "-A");
  git(base, "commit", "-qm", "writer");
  const committed = await gitOwnershipChangedPaths({
    projectCwd: nested, baseSha: frozen.headSha, compareCommitted: true,
  });
  expect(committed.status).toBe("ready");
  expect(committed.paths.sort()).toEqual(["index.ts", "new.ts"]);
});
