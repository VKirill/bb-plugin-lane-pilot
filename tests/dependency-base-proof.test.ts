import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../src/rooms/plugin-db";
import { upsertAttemptChange } from "../src/rooms/rollback/store";
import { createWriterSpawn } from "../src/rooms/writer/server/spawn";
import { runCommandOnHost } from "../src/rooms/writer/cli-run";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

const taskOf = (workspace: string, id: string, dependsOn: string[] = []): TaskV2 => ({
  schema_version: 2, id, title: id, risk: "low", lane: "writer", project_cwd: workspace, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`${id}.md`], owns_paths: [`${id}.md`], never_touch: [], depends_on: dependsOn,
  objective: id, acceptance: ["done"], verify: "none", verification: [],
});

const makeWorld = (probe: "valid-alias" | "no-deps" | "no-merge" | "reverted" | "stale" | "host-failure" | "malformed" | "invalid-row") => {
  const repo = mkdtempSync(join(tmpdir(), "lp-dependency-proof-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  const before = git(repo, "rev-parse", "HEAD");
  const stale = join(repo, "stale");
  git(repo, "worktree", "add", "-q", "-b", "lane/stale", stale, before);
  writeFileSync(join(repo, "dependency.md"), "dependency\n");
  git(repo, "add", "dependency.md");
  git(repo, "commit", "-q", "-m", "dependency");
  const dependencyCommit = git(repo, "rev-parse", "HEAD");
  const dependencyId = probe === "valid-alias" ? "dep.2" : "dep";

  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", stale);
  setRunThread(db, "run", "pm");
  const dependency = taskOf(stale, dependencyId);
  const task = taskOf(stale, "child", probe === "no-deps" ? [] : probe === "valid-alias" ? ["dep", "dep.2"] : ["dep"]);
  createTask(db, { id: dependencyId, runId: "run", kind: "bb", contract: dependency });
  createTask(db, { id: "child", runId: "run", kind: "bb", contract: task });
  createAttempt(db, { id: "dep-attempt", runId: "run", taskId: dependencyId });
  transitionAttempt(db, "dep-attempt", "spawn_requested");
  transitionAttempt(db, "dep-attempt", "running", { threadId: "dep-thread" });
  if (probe !== "no-merge") upsertAttemptChange(db as never, { attemptId: "dep-attempt", runId: "run", taskId: dependencyId }, { outcome: "merged", mergeCommit: probe === "invalid-row" ? "not-a-sha" : dependencyCommit });
  transitionAttempt(db, "dep-attempt", "accepted");
  createAttempt(db, { id: "child-attempt", runId: "run", taskId: "child" });
  if (probe === "valid-alias" || probe === "no-deps" || probe === "no-merge" || probe === "reverted") git(stale, "merge", "-q", "--ff-only", "main");
  if (probe === "reverted") {
    git(stale, "revert", "--no-edit", dependencyCommit);
    upsertAttemptChange(db as never, { attemptId: "dep-attempt", runId: "run", taskId: dependencyId }, { outcome: "reverted" });
  }

  const spawned: unknown[] = [];
  const ctx = {
    bb: {
      storage: bb.storage,
      log: { info() {}, warn() {} },
      hosts: { experimental_client: () => ({ call: async (method: string) => { throw new Error(`unexpected host method ${method}`); } }) },
      sdk: {
        projects: { get: async () => ({ sources: [] }) },
        providers: {
          list: async () => [{ id: "codex", available: true, serviceTiers: [{ id: "default" }] }],
          models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }),
        },
        files: { read: async () => ({ content: null }) },
        threads: {
          get: async () => ({ id: "pm", projectId: "P", status: "idle" }),
          stop: async () => ({}),
          spawn: async (args: unknown) => { spawned.push(args); return { id: "writer-thread" }; },
        },
      },
    },
    db,
    log() {},
    host: {
      call: async (method: string, input: { cwd?: string; command?: string }) => {
        if (method !== "runCommand") return {};
        if (input.command?.includes("git rev-parse --verify HEAD")) {
          if (probe === "host-failure") throw new Error("host unavailable");
          if (probe === "malformed") return { hostId: "h", exitCode: 0, stdout: "not a dependency proof\n", stderr: "" };
        }
        return runCommandOnHost({ requestedHostId: "h", cwd: input.cwd!, command: input.command!, timeoutSec: 30 });
      },
    },
    effectiveProjectSettings: async () => ({ values: { "memory.enabled": false, "adoc.040": "worktree" } }),
  };
  const services = { providerBreaker: { decide: () => ({ allow: true }) }, ruleScan: { chainForRun: async () => [] } };
  const writer = createWriterSpawn(ctx as never, services as never);
  const config: PrototypeConfig = {
    projectId: "P", hostId: "h", pmWorkspacePath: stale, writerWorkspacePath: stale,
    pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test",
  };
  return { writer, config, task, spawned, db, stale, dependencyCommit, before };
};

it("accepts a valid ancestor once for base and redispatch aliases", async () => {
  const world = makeWorld("valid-alias");
  const result = await world.writer.spawnWriterAttempt({ projectId: "P", runId: "run", taskId: "child", attemptId: "child-attempt", config: world.config, task: world.task, plan: "child", pmThreadId: "pm" });
  expect(result).toMatchObject({ ok: true, threadId: "writer-thread" });
  expect(world.spawned).toHaveLength(1);
});

it.each(["no-deps", "no-merge"] as const)("preserves the intentional %s exception", async (probe) => {
  const world = makeWorld(probe);
  const result = await world.writer.spawnWriterAttempt({ projectId: "P", runId: "run", taskId: "child", attemptId: "child-attempt", config: world.config, task: world.task, plan: "child", pmThreadId: "pm" });
  expect(result).toMatchObject({ ok: true, threadId: "writer-thread" });
  expect(world.spawned).toHaveLength(1);
});

it("refuses the real stale git base before calling threads.spawn", async () => {
  const world = makeWorld("stale");
  const result = await world.writer.spawnWriterAttempt({ projectId: "P", runId: "run", taskId: "child", attemptId: "child-attempt", config: world.config, task: world.task, plan: "child", pmThreadId: "pm" });
  expect(result).toMatchObject({ ok: false, status: "spawn_rejected" });
  expect((result as { reason: string }).reason).toContain("attempt_worktree_base_missing_dependency");
  expect(world.spawned).toHaveLength(0);
});

it("refuses a reverted accepted dependency even while its original merge remains an ancestor", async () => {
  const world = makeWorld("reverted");
  expect(() => git(world.stale, "merge-base", "--is-ancestor", world.dependencyCommit, "HEAD")).not.toThrow();
  const result = await world.writer.spawnWriterAttempt({ projectId: "P", runId: "run", taskId: "child", attemptId: "child-attempt", config: world.config, task: world.task, plan: "child", pmThreadId: "pm" });
  expect(result).toMatchObject({ ok: false, status: "spawn_rejected" });
  expect((result as { reason: string }).reason).toContain("attempt_worktree_base_unproven");
  expect(world.spawned).toHaveLength(0);
});

it.each(["host-failure", "malformed", "invalid-row"] as const)("refuses a %s dependency proof before calling threads.spawn", async (probe) => {
  const world = makeWorld(probe);
  const result = await world.writer.spawnWriterAttempt({ projectId: "P", runId: "run", taskId: "child", attemptId: "child-attempt", config: world.config, task: world.task, plan: "child", pmThreadId: "pm" });
  expect(result).toMatchObject({ ok: false, status: "spawn_rejected" });
  expect((result as { reason: string }).reason).toContain("attempt_worktree_base_unproven");
  expect(world.spawned).toHaveLength(0);
});
