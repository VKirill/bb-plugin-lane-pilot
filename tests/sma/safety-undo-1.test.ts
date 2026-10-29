import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRollback } from "../../src/rooms/rollback/server";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage/database";
import { createWorktree, integrateWorktree, removeLaneWorktree } from "../../src/rooms/verification/git-integrate";
import { mergeInfo, revertCommitsInWorktree, worktreeState } from "../../src/rooms/verification/git-rollback";
import { resolveGitOwnershipBase } from "../../src/rooms/verification/git-ownership";
import { git } from "../verification/git-integrate-helpers";

const HOST = "host-1";

async function world() {
  const root = await mkdtemp(join(tmpdir(), "sma-undo-"));
  const base = join(root, "project");
  git(root, "init", "-q", "-b", "main", base);
  await writeFile(join(base, "server.ts"), "line1\nline2\nline3\n");
  git(base, "add", "-A");
  git(base, "commit", "-qm", "base");
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", base, "none", undefined, HOST);
  const host = {
    call: async (method: string, input: Record<string, any>) => {
      const hostId = HOST;
      switch (method) {
        case "gitCreateWorktree": return { hostId, ...await createWorktree({ basePath: input.basePath, name: input.name, commit: input.commit, targetPath: join(root, "wt", input.name, basename(input.basePath)) }) };
        case "gitPrepareWorktree": return { hostId, linked: [] };
        case "gitRemoveWorktree": return { hostId, ...await removeLaneWorktree({ basePath: input.basePath, worktreePath: input.worktreePath }) };
        case "gitMergeInfo": return { hostId, ...await mergeInfo({ basePath: input.basePath, commit: input.commit, attemptId: input.attemptId }) };
        case "gitRevertCommits": return { hostId, ...await revertCommitsInWorktree({ worktreePath: input.worktreePath, commits: input.commits }) };
        case "gitWorktreeState": return { hostId, ...await worktreeState({ basePath: input.basePath, worktreePath: input.worktreePath }) };
        case "gitOwnershipBase": return { hostId, ...await resolveGitOwnershipBase({ projectCwd: input.projectCwd }) };
        case "gitIntegrate": return { hostId, ...await integrateWorktree({ basePath: input.basePath, worktreePath: input.worktreePath, message: input.message, removeWorktree: input.removeWorktree }) };
        default: throw new Error(`unexpected host call ${method}`);
      }
    },
  };
  const { rollback } = createRollback({
    bb, db, host, log: () => undefined, isDisposed: () => false,
    configForRun: async () => ({ projectId: "projA", hostId: HOST, writerWorkspacePath: base }),
  } as never, {
    runVerification: async (_config: unknown, task: { verification: Array<{ command: string; cwd: string }> }) => task.verification.map((check) => {
      const ran = spawnSync("bash", ["-lc", check.command], { cwd: check.cwd, encoding: "utf8" });
      return { command: check.command, exitCode: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
    }),
  } as never);
  return { base, db, rollback, dispose: async () => { await harness.lifecycle.dispose(); await rm(root, { recursive: true, force: true }); } };
}

describe("undo", () => {
  it("[sma:k_v_undo] [sma:k_v_rollbacks] one revert puts the tree back, and a later check names that rollback", async () => {
    const w = await world();
    try {
      const task = {
        schema_version: 2, id: "t1", title: "title of t1", risk: "low", lane: "server", project_cwd: w.base, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
        expected_outputs: ["x"], owns_paths: ["**"], never_touch: [], depends_on: [], objective: "t1", acceptance: ["done"], verify: "tests",
        verification: [{ command: "test -f server.ts", cwd: w.base }],
      };
      createTask(w.db, { id: "t1", runId: "run1", kind: "bb", contract: task });
      createAttempt(w.db, { id: "att_t1", runId: "run1", taskId: "t1" });
      const made = await createWorktree({ basePath: w.base, name: "att_t1", targetPath: join(w.base, "..", "wt", "att_t1", "project") });
      w.rollback.noteBase("att_t1", made.baseSha);
      await writeFile(join(made.path!, "server.ts"), "rewritten\n");
      const merged = await integrateWorktree({ basePath: w.base, worktreePath: made.path!, message: "t1: title of t1\n\nLane-Pilot-Attempt: att_t1", removeWorktree: true });
      expect(merged.status).toBe("merged");
      w.rollback.noteMerge("att_t1", merged);
      w.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att_t1'").run();
      expect(await readFile(join(w.base, "server.ts"), "utf8")).toBe("rewritten\n");
      const result = await w.rollback.revert("t1");
      expect(result).toMatchObject({ ok: true, state: "merged" });
      expect(await readFile(join(w.base, "server.ts"), "utf8")).toBe("line1\nline2\nline3\n");
      const checked = await w.rollback.reverify("t1");
      expect(checked.revertedIn).toBe(result.commit);
      expect(checked.summary).toContain("was reverted");
    } finally { await w.dispose(); }
  });

  it("[sma:k_v_reverify] re-runs the task's checks on the accepted commit, not on whatever main is now", async () => {
    const w = await world();
    try {
      const task = {
        schema_version: 2, id: "t1", title: "title of t1", risk: "low", lane: "server", project_cwd: w.base, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
        expected_outputs: ["x"], owns_paths: ["**"], never_touch: [], depends_on: [], objective: "t1", acceptance: ["done"], verify: "tests",
        verification: [{ command: "grep -qx rewritten server.ts", cwd: w.base }],
      };
      createTask(w.db, { id: "t1", runId: "run1", kind: "bb", contract: task });
      createAttempt(w.db, { id: "att_t1", runId: "run1", taskId: "t1" });
      const made = await createWorktree({ basePath: w.base, name: "att_t1", targetPath: join(w.base, "..", "wt", "att_t1", "project") });
      w.rollback.noteBase("att_t1", made.baseSha);
      await writeFile(join(made.path!, "server.ts"), "rewritten\n");
      const merged = await integrateWorktree({ basePath: w.base, worktreePath: made.path!, message: "t1: title of t1\n\nLane-Pilot-Attempt: att_t1", removeWorktree: true });
      expect(merged.status).toBe("merged");
      w.rollback.noteMerge("att_t1", merged);
      w.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att_t1'").run();
      await writeFile(join(w.base, "server.ts"), "later\n");
      git(w.base, "add", "-A");
      git(w.base, "commit", "-qm", "later");
      const checked = await w.rollback.reverify("t1");
      expect(checked).toMatchObject({ ok: true, state: "passed" });
      expect(checked.summary).toContain("1/1");
      expect(await readFile(join(w.base, "server.ts"), "utf8")).toBe("later\n");
    } finally { await w.dispose(); }
  });
});
