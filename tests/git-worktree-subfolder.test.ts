import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { PARKED_CLASSES, failureClass } from "../src/failure-class";
import { openDatabase } from "../src/database";
import { createSelfRepair } from "../src/server/self-repair";
import type { ServerCore } from "../src/server/core";
import { worktreeCreateError } from "../src/server/writer/spawn";
import { createWorktree } from "../src/verification/git-integrate";

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

it("refuses a writer worktree when the chat folder is a subfolder of a git repo", async () => {
  const { base, nested } = await nestedWorkspace();
  const created = await createWorktree({ basePath: nested, targetPath: join(base, "..", "own", "bot"), name: "lpattempt_sub" });
  expect(created.status).toBe("failed");
  expect(created.path).toBeNull();
  expect(created.reason).toMatch(/^workspace_not_repo_root:/);
  expect(created.reason).toContain(nested);
  expect(created.reason).toContain(base);
  expect(created.reason).toMatch(/Open the Lane chat at /);
});

it("creates a writer worktree when the chat folder is the git repo root", async () => {
  const { base } = await nestedWorkspace();
  const target = join(base, "..", "own", "main");
  const created = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_root" });
  expect(created).toMatchObject({ status: "ready", path: target, branch: "lane/lpattempt_root", reason: null });
});

it("keeps the subfolder refusal as a task-side block, not a Lane Pilot fault", async () => {
  const reason = worktreeCreateError("workspace_not_repo_root: /chat/apps/bot is not the git repo root /chat (2 uncommitted files)");
  expect(reason.startsWith("workspace_not_repo_root:")).toBe(true);
  expect(reason.startsWith("attempt_worktree_failed:")).toBe(false);
  expect(worktreeCreateError("fatal: already exists")).toBe("attempt_worktree_failed:fatal: already exists");
  const klass = failureClass("spawn_rejected", reason);
  expect(klass).toBe("task");
  expect(PARKED_CLASSES.has(klass)).toBe(false);
});

it("does not pick the subfolder refusal for self-repair, even across several tasks", async () => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const ctx = { bb, db, log: () => undefined, isDisposed: () => false } as unknown as ServerCore;
  const now = Date.now();
  db.prepare("INSERT INTO lane_pilot_run (id,project_id,pm_thread_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("lprun_a", "proj_real", "thr_pm", "running", now, now);
  const reason = "workspace_not_repo_root: /repo/apps/bot is not the git repo root /repo (3 uncommitted files)";
  for (const n of [1, 2, 3]) {
    db.prepare("INSERT INTO lane_pilot_attempt (id,run_id,task_id,thread_id,state,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(`lpattempt_${n}`, "lprun_a", `task-${n}`, `thr_w_${n}`, "blocked", reason, now, now);
    db.prepare(`INSERT INTO lane_pilot_failure_triage (project_id,attempt_id,run_id,task_id,reason_sha256,reason,origin,status,failed_at,triaged_at)
      VALUES (?,?,?,?,?,?,?,'ok',?,?)`).run("proj_real", `lpattempt_${n}`, "lprun_a", `task-${n}`, "x", reason, "orchestrator", now, now);
  }
  const rows = await createSelfRepair(ctx).collect(0, await createSelfRepair(ctx).config());
  expect(rows).toEqual([]);
});
