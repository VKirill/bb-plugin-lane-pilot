// A merge turn (main moved, the writer resolves the conflict in its worktree) measured the writer's work against the
// snapshot taken before Lane Pilot merged main in. The conflicted merge stays unfinished, so main's own changes sit
// staged in the worktree and were counted as the writer's: Vampirism Fire vf-untrack-pycache attempt 2
// (lpattempt_7b027b98499b4b5f84eb076834d4c8f9, 2026-10-23) failed with «owns_paths rejected game/AGENTS.md,
// game/scripts/studio_test.py», two files vf-runner-dedupe had just merged into main.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, setAttemptWorkspace, transitionAttempt } from "../../src/rooms/storage/database";
import { classifyWriterOutput } from "../../src/rooms/tasks/validate-output";
import { syncWorktree } from "../../src/rooms/verification/git-integrate";
import { WORKSPACE_DIRT_COMMAND } from "../../src/rooms/verification/workspace-dirt";
import { attemptProduced, parseDirtSnapshots, type DirtSnapshot } from "../../src/rooms/writer/cli-outcome";
import { createWriterSticky } from "../../src/rooms/writer/server/sticky";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const snapshot = (cwd: string): DirtSnapshot[] => parseDirtSnapshots(execFileSync("sh", ["-c", WORKSPACE_DIRT_COMMAND], { cwd, encoding: "utf8" }));
const pyc = "game/scripts/__pycache__/studio_test.cpython-314.pyc";
const check = "! git ls-files | grep -q __pycache__ && grep -qx '__pycache__/' .gitignore";

/** The contract of vf-untrack-pycache as the hub stored it (lprun_18aa9a163f6d4824aa8c5572b9dec21f). */
const contract = (cwd: string) => ({
  schema_version: 2, id: "vf-untrack-pycache", title: "Stop tracking Python bytecode caches (__pycache__) and ignore them", risk: "low",
  lane: "default", project_cwd: cwd, read_first: [".gitignore"], interfaces: [".gitignore"],
  invariants: ["No source file is removed; only *.pyc under __pycache__ leave the index"], out_of_scope: ["Any other cleanup"],
  expected_outputs: [".gitignore"], owns_paths: [".gitignore", "scripts/__pycache__/", "game/scripts/__pycache__/"],
  never_touch: ["game/src/", "docs/", "research/", ".git/hooks/**", ".husky/**", ".claude/**", "lane-stack/hooks/**", ".github/workflows/**"],
  depends_on: [], objective: "Running scripts in the main checkout no longer leaves uncommitted changes that block merges.",
  acceptance: [".gitignore contains `__pycache__/` and `*.pyc`."], verify: "smoke",
  verification: [{ command: check, cwd, timeout_sec: 30 }], area: "chore:repo",
}) as never;

/** Main and the attempt's worktree, at the moment the first attempt hit merge_conflict on the .pyc. */
async function conflictedProject() {
  const root = await mkdtemp(join(tmpdir(), "lp-merge-turn-"));
  const base = join(root, "Roblox - Vampirism Fire");
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  await mkdir(join(base, "game/scripts/__pycache__"), { recursive: true });
  await writeFile(join(base, ".gitignore"), "node_modules/\n");
  await writeFile(join(base, "game/AGENTS.md"), "# game\n");
  await writeFile(join(base, "game/scripts/studio_test.py"), "print('run')\n");
  await writeFile(join(base, pyc), "bytecode 1\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");
  const worktree = join(root, "lpattempt_ec2486ea28e547e3bc789c5b40258e80", "Roblox - Vampirism Fire");
  git(base, "worktree", "add", "-q", "-b", "lane/lpattempt_ec2486ea", worktree, "main");
  // The writer's first turn, committed by gitIntegrate on its way to main.
  await writeFile(join(worktree, ".gitignore"), "node_modules/\n__pycache__/\n*.pyc\n");
  git(worktree, "rm", "-q", "--cached", pyc);
  git(worktree, "add", "-A"); git(worktree, "commit", "-qm", "untrack pycache");
  // vf-runner-dedupe merged meanwhile, and running the tests in main rewrote the tracked .pyc.
  await writeFile(join(base, "game/AGENTS.md"), "# game\nOne Studio test runner.\n");
  await writeFile(join(base, "game/scripts/studio_test.py"), "print('run once')\n");
  await writeFile(join(base, pyc), "bytecode 2\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "vf-runner-dedupe");
  return { base, worktree };
}

function sticky(base: string) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sdk = {
    threads: {
      get: vi.fn(async () => ({ status: "idle", archivedAt: null })),
      context: vi.fn(async () => ({ usage: { usedTokens: 1_000, modelContextWindow: 200_000 } })),
      compact: vi.fn(async () => ({ ok: true })),
      updatePluginMetadata: vi.fn(async () => ({})),
      send: vi.fn(async () => ({})),
    },
    environments: { get: vi.fn(async () => ({ id: "env", archivedAt: null })) },
  };
  // The host's own sync and dirt snapshot, run for real on the repositories above.
  const host = { call: vi.fn(async (method: string, input: { basePath: string; worktreePath: string; keepConflicts?: boolean }) =>
    method === "gitSyncWorktree" ? { hostId: "h", ...await syncWorktree(input) } : { hostId: "h", linked: [] }) };
  const services = { workspaceDirt: vi.fn(async (_config: unknown, path: string) => {
    const snapshots = snapshot(path);
    return { ok: true, paths: snapshots.map((row) => row.path), snapshots };
  }) };
  const db = openDatabase(bb);
  createRun(db, "lprun_18aa9a163f6d4824aa8c5572b9dec21f", "proj_9tzjyzsumb", "bb", base);
  return { db, sticky: createWriterSticky({ bb: { storage: bb.storage, sdk }, db, host, log: () => undefined, isDisposed: () => false } as never, services as never) };
}

describe("a merge turn measures the writer against the worktree after main was merged in", () => {
  it("does not count main's merged files as the writer's (vf-untrack-pycache, 2026-10-23)", async () => {
    const { base, worktree } = await conflictedProject();
    const env = sticky(base);
    const runId = "lprun_18aa9a163f6d4824aa8c5572b9dec21f";
    createTask(env.db, { id: "vf-untrack-pycache", runId, kind: "bb", contract: contract(base) });
    createAttempt(env.db, { id: "first", runId, taskId: "vf-untrack-pycache" });
    setAttemptWorkspace(env.db, "first", { path: worktree, environmentId: null, decision: { strategy: "provision_attempt_worktree" } });
    transitionAttempt(env.db, "first", "spawn_requested");
    transitionAttempt(env.db, "first", "running", { threadId: "thr_id28dbu4q7" });
    transitionAttempt(env.db, "first", "validation_failed", { reason: `merge_conflict: main changed since this attempt started: ${pyc}` });
    const redo = (await env.sticky.retryWriter("first", runId))!;
    expect(redo.kind).toBe("merge");
    createAttempt(env.db, { id: "merge-turn", runId, taskId: "vf-untrack-pycache" });
    // start.ts hands over the failed attempt's own snapshot (clean worktree: none).
    const turn = await env.sticky.continueInThread({ runId, taskId: "vf-untrack-pycache", attemptId: "merge-turn", config: { hostId: "h" } as never,
      writer: redo, prompt: (conflicts) => `resolve ${conflicts.join(", ")}`, kind: "merge", dirtBefore: [] });
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    expect(turn.dirtBefore.map((row) => row.path)).toEqual(expect.arrayContaining(["game/AGENTS.md", "game/scripts/studio_test.py"]));
    expect(getAttempt(env.db, "merge-turn")!.dirt_before).toEqual(turn.dirtBefore);

    // The writer resolves the modify/delete conflict for its task and leaves the merge for Lane Pilot to commit.
    git(worktree, "rm", "-q", "--cached", pyc);
    const produced = attemptProduced(snapshot(worktree), turn.dirtBefore);
    expect(produced).not.toContain("game/AGENTS.md");
    expect(produced).not.toContain("game/scripts/studio_test.py");
    expect(classifyWriterOutput({ task: contract(worktree), produced: [...produced, ".gitignore"], contents: { ".gitignore": "__pycache__/\n" },
      verifies: [{ command: check, exitCode: 0, stdout: "", stderr: "" }] }))
      .toMatchObject({ ok: true });
    // What the old baseline (the snapshot from before the merge) made of the same worktree.
    expect(classifyWriterOutput({ task: contract(worktree), produced: attemptProduced(snapshot(worktree), []), contents: {} }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("owns_paths rejected game/AGENTS.md, game/scripts/studio_test.py") });
  });
});
