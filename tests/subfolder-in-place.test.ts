import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/contracts";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, setAttemptWorkspace, setRunThread } from "../src/database";
import { createWriterSpawn, shouldMergeAttemptWorktree } from "../src/server/writer/spawn";
import { blocksSharedFolderWriter } from "../src/server/writer/start";
import { dirtInsideWorkspace } from "../src/verification/git-ownership";

const folder = "/repo/apps/bot";
const config: PrototypeConfig = {
  projectId: "P", hostId: "h", pmWorkspacePath: folder, writerWorkspacePath: folder,
  pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test",
};
const task: TaskV2 = {
  schema_version: 2, id: "t1", title: "Write in the subfolder", risk: "high", lane: "writer",
  project_cwd: folder, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["index.ts"], owns_paths: ["index.ts", "new.ts"], never_touch: [], depends_on: [],
  objective: "edit the bot", acceptance: ["files exist"], verify: "none", verification: [],
};

function spawnEnv(options: { bound?: boolean; createReason?: string } = {}) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", folder);
  setRunThread(db, "run", "pm");
  createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
  createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
  if (options.bound) {
    setAttemptWorkspace(db, "a1", { path: folder, environmentId: null, decision: { strategy: "provision_attempt_worktree" } });
  }
  const hostCalls: string[] = [];
  const spawned: unknown[] = [];
  const ctx = {
    bb: {
      storage: bb.storage,
      log: { info() {}, warn() {} },
      sdk: {
        projects: { get: async () => ({ sources: [] }) },
        providers: {
          list: async () => [{ id: "codex", available: true, serviceTiers: [{ id: "default" }] }],
          models: async () => ({
            models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }],
          }),
        },
        files: { read: async () => ({ content: null }) },
        threads: {
          get: async () => ({ id: "pm", projectId: "P", status: "idle" }),
          spawn: async (args: unknown) => { spawned.push(args); return { id: "writer-1" }; },
        },
      },
    },
    db,
    host: {
      call: async (method: string, input: { cwd?: string }) => {
        hostCalls.push(method);
        if (method === "runCommand") return { hostId: "h", exitCode: 0, stdout: "[]", stderr: "" };
        if (method === "gitCreateWorktree") {
          return {
            status: "failed", path: null,
            reason: options.createReason ?? "workspace_not_repo_root: /repo/apps/bot is not the git repo root /repo. Open the Lane chat at /repo",
          };
        }
        return {};
      },
    },
    effectiveProjectSettings: async () => ({ values: { "jev.LANE_JEV_EFFORT": false, "memory.enabled": false, "adoc.040": "auto" } }),
  };
  const services = { providerBreaker: { decide: () => ({ allow: true }) }, ruleScan: { chainForRun: async () => [] } };
  return { db, hostCalls, spawned, writer: createWriterSpawn(ctx as never, services as never) };
}

it("runs in place when gitCreateWorktree refuses a nested chat folder", async () => {
  const { db, hostCalls, spawned, writer } = spawnEnv();
  const result = await writer.spawnWriterAttempt({
    projectId: "P", runId: "run", taskId: "t1", attemptId: "a1", config, task, plan: "edit the bot", pmThreadId: "pm",
  });
  expect(result).toMatchObject({ ok: true, workspacePath: folder, threadId: "writer-1" });
  expect(hostCalls.filter((method) => method === "gitCreateWorktree")).toHaveLength(1);
  expect(hostCalls).not.toContain("gitPrepareWorktree");
  expect(getAttempt(db, "a1")).toMatchObject({ workspace_path: folder, environment_id: null, state: "running" });
  expect((spawned[0] as { environment: unknown }).environment)
    .toEqual({ type: "host", hostId: "h", workspace: { type: "unmanaged", path: folder } });
});

it("does not retry the worktree on resume of an in-place fallback", async () => {
  const { db, hostCalls, writer } = spawnEnv({ bound: true });
  const result = await writer.spawnWriterAttempt({
    projectId: "P", runId: "run", taskId: "t1", attemptId: "a1", config, task, plan: "edit the bot", pmThreadId: "pm",
  });
  expect(result).toMatchObject({ ok: true, workspacePath: folder });
  expect(hostCalls).not.toContain("gitCreateWorktree");
  expect(getAttempt(db, "a1")?.workspace_path).toBe(folder);
});

it("still rejects other gitCreateWorktree failures", async () => {
  const { writer } = spawnEnv({ createReason: "fatal: already exists" });
  const result = await writer.spawnWriterAttempt({
    projectId: "P", runId: "run", taskId: "t1", attemptId: "a1", config, task, plan: "edit the bot", pmThreadId: "pm",
  });
  expect(result).toMatchObject({ ok: false, status: "spawn_rejected", reason: "attempt_worktree_failed:fatal: already exists" });
});

it("does not merge or remove a worktree when the attempt stayed in the run folder", () => {
  expect(shouldMergeAttemptWorktree(folder, folder)).toBe(false);
  expect(shouldMergeAttemptWorktree("/repo/apps/bot/", folder)).toBe(false);
  expect(shouldMergeAttemptWorktree("/home/me/.lane-pilot/worktrees/a1/bot", folder)).toBe(true);
  expect(shouldMergeAttemptWorktree(null, folder)).toBe(false);
});

it("blocks a second in-place writer in the same folder", () => {
  const earlier = { task_id: "t1", project_id: "P", folder };
  const mine = { taskId: "t2", projectId: "P", folder };
  expect(blocksSharedFolderWriter(earlier, mine)).toBe(true);
  expect(blocksSharedFolderWriter({ ...earlier, folder: "/other" }, mine)).toBe(false);
  expect(blocksSharedFolderWriter(earlier, { ...mine, taskId: "t1" })).toBe(false);
  expect(blocksSharedFolderWriter({ ...earlier, dependsOn: ["t2"] }, mine)).toBe(false);
});

it("keeps dirt paths relative to a nested chat folder", () => {
  expect(dirtInsideWorkspace([
    { path: "apps/bot/index.ts", sha256: "aa" },
    { path: "apps/bot/new.ts", sha256: "bb" },
    { path: "root.ts", sha256: "cc" },
  ], "apps/bot")).toEqual([
    { path: "index.ts", sha256: "aa" },
    { path: "new.ts", sha256: "bb" },
  ]);
});

it("snapshots nested-folder dirt from the repo root then strips the prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-inplace-"));
  const base = join(root, "main");
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  await writeFile(join(base, "root.ts"), "export {};\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: base });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: base });
  const nested = join(base, "apps", "bot");
  await mkdir(nested, { recursive: true });
  const hostCwds: string[] = [];
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const ctx = {
    bb: { storage: bb.storage, log: { info() {}, warn() {} }, sdk: { projects: { get: async () => ({ sources: [] }) } } },
    db: openDatabase(bb),
    host: {
      call: async (method: string, input: { cwd?: string }) => {
        if (method === "runCommand") {
          hostCwds.push(input.cwd ?? "");
          return { hostId: "h", exitCode: 0, stdout: JSON.stringify([
            { path: "apps/bot/index.ts", sha256: "aa" },
            { path: "root.ts", sha256: "cc" },
          ]), stderr: "" };
        }
        return {};
      },
    },
    effectiveProjectSettings: async () => ({ values: {} }),
  };
  const { workspaceDirt } = createWriterSpawn(ctx as never, { providerBreaker: { decide: () => ({ allow: true }) } } as never);
  const dirt = await workspaceDirt({ ...config, writerWorkspacePath: nested }, nested);
  expect(dirt).toEqual({ ok: true, paths: ["index.ts"], snapshots: [{ path: "index.ts", sha256: "aa" }] });
  expect(await realpath(hostCwds[0]!)).toBe(await realpath(base));
});
