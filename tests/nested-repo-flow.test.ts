import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import * as handlers from "../src/rooms/host-worker/host-handlers";
import type { TaskV2 } from "../src/rooms/contracts";
import { createRun, getAttempt, getTask, getTaskPlan, listAttemptsForTask, listStageReceipts, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../src/rooms/storage/database";

const projectId = "project-umbrella";
const pmThreadId = "pm-umbrella";
const runId = "run-umbrella";
const realHome = process.env.HOME;
const roots: string[] = [];

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/**
 * A run folder without git that holds a plugin repository, as BB-сервис holds 41: the whole plugin with the host's real
 * handlers (runCommand, git worktree, ownership, integrate). The writer edits the worktree Lane Pilot gave it.
 */
async function setup(writerEdits: (workspace: string) => string) {
  const home = mkdtempSync(join(tmpdir(), "lane-pilot-home-"));
  roots.push(home);
  process.env.HOME = home;
  const folder = mkdtempSync(join(tmpdir(), "lane-pilot-umbrella-"));
  roots.push(folder);
  put(folder, "notes.md", "the umbrella's own file\n");
  put(folder, "plugins/p/src/hello.ts", "export const hello = \"old\";\n");
  put(folder, "plugins/p/README.md", "plugin p\n");
  put(folder, "plugins/q/src/other.ts", "export const other = 1;\n");
  git(join(folder, "plugins", "p"), "init", "-q", "-b", "main");
  git(join(folder, "plugins", "p"), "add", "-A");
  git(join(folder, "plugins", "p"), "commit", "-q", "-m", "init");
  const config = {
    projectId, hostId: "host-umbrella", pmWorkspacePath: folder, writerWorkspacePath: folder,
    pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test",
  };
  // As the PM wrote it on 2026-10-10: from the umbrella folder, with a reference file of another plugin to read.
  const task: TaskV2 = {
    schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:p-hello", id: "p-hello", title: "Say hello in plugin p", risk: "low", lane: "writer", project_cwd: folder,
    read_first: ["plugins/p/README.md", "plugins/q/src/other.ts"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"],
    expected_outputs: ["plugins/p/src/hello.ts"], owns_paths: ["plugins/p/src/"], never_touch: ["plugins/q/"], depends_on: [],
    objective: "say hello", acceptance: ["hello.ts says hello"], verify: "none", verification: [],
  };
  const spawnedAt: string[] = [];
  const hostCalls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let answer = "";
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: {
      getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : { role: "writer" },
      spawn: async (args) => {
        const spawn = args as { pluginMetadata?: { role?: unknown }; environment?: { workspace?: { path?: string } } };
        if (spawn.pluginMetadata?.role === "writer") {
          const workspace = spawn.environment?.workspace?.path ?? "";
          spawnedAt.push(workspace);
          answer = writerEdits(workspace);
        }
        return { id: "writer-umbrella" } as never;
      },
      get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId }) as never,
      output: async () => ({ text: answer }),
      list: async () => [] as never,
      context: async () => ({ usage: null }) as never,
      updatePluginMetadata: async () => ({}) as never,
      send: async () => undefined,
      events: { list: async () => [] as never },
    }, providers: {
      list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
      models: async () => ({ models: [{ id: "codex-test", model: "codex-test",
        supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
    }, files: {
      read: async (args) => {
        const path = (args as { path: string }).path;
        return existsSync(path) ? { content: readFileSync(path, "utf8") } : { content: null };
      },
      listPaths: async () => ({ paths: [] }) as never,
      write: async (args) => { put("/", (args as { path: string }).path, (args as { content: string }).content); return { ok: true } as never; },
    }, projects: {
      get: async () => ({ id: projectId, name: projectId, sources: [{ hostId: "host-umbrella", path: folder }] }) as never,
      list: async () => [] as never,
    } },
    experimental_callHostRpc: async (call) => {
      const input = call.input as Record<string, unknown>;
      hostCalls.push({ method: call.method, input });
      if (call.method === "classifyPlan") {
        return { hostId: "host-umbrella", status: "ok", effort: "medium", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
      }
      if (call.method === "diskFree") return { hostId: "host-umbrella", status: "ok", freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 };
      const handler = (handlers as Record<string, unknown>)[call.method];
      if (typeof handler !== "function") throw new Error(`unexpected host call ${call.method}`);
      return (handler as (input: unknown) => unknown)(input);
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  for (const [key, value] of [["plan_critique.enabled", false], ["memory.enabled", false], ["jev.LANE_JEV_EFFORT", false], ["workspace.provider", false],
    ["integration.gate", "off"], ["docs.enabled", false], ["project_life.enabled", false]] as const) saveProjectSetting(db, projectId, key, value);
  createRun(db, runId, projectId, "bb", folder);
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const dispatch = async (patch: Partial<TaskV2> = {}) => JSON.parse(String(await harness.behavior.callAgentTool(
    "lane_pilot_dispatch_writer", { confirm: true, objective: "Проверка диспетча", plan: "Make hello.ts say hello", task: { ...task, ...patch } }, { threadId: pmThreadId, projectId },
  ))) as Record<string, unknown>;
  const finished = async (taskId = "p-hello") => {
    for (let i = 0; i < 600; i++) {
      const latest = listAttemptsForTask(db, runId, taskId).at(-1);
      if (latest && !["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(latest.state)
        && !listStageReceipts(db, runId, taskId).some((row) => row.state === "running" || row.state === "pending")) return latest;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the task never finished");
  };
  return { db, harness, folder, dispatch, finished, spawnedAt, hostCalls };
}

beforeEach(() => { process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "5000"; });
afterEach(() => {
  delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS;
  process.env.HOME = realHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a task over one repository of a run folder without git (BB-сервис 2026-10-11)", () => {
  it("moves into the repository, works in its own worktree and merges into the repository's main", async () => {
    const env = await setup((workspace) => {
      put(workspace, "src/hello.ts", "export const hello = \"hello\";\n");
      return "Changed src/hello.ts";
    });
    const sent = await env.dispatch();
    expect(JSON.stringify(sent.warnings ?? [])).not.toContain("mode live-folder");
    expect(JSON.stringify(sent.warnings ?? [])).toContain("mode repository: every path of this task is inside the git repository plugins/p");
    // The stored contract is the repository's: paths relative to it, the other plugin's reference file in the plan.
    const stored = getTask(env.db, "p-hello")!.contract as TaskV2;
    expect(stored).toMatchObject({ project_cwd: join(env.folder, "plugins", "p"), owns_paths: ["src/"], expected_outputs: ["src/hello.ts"],
      read_first: ["README.md"], never_touch: [] });
    expect(getTaskPlan(env.db, "p-hello")).toContain(join(env.folder, "plugins", "q", "src", "other.ts"));
    const attempt = await env.finished();
    expect(getAttempt(env.db, attempt.id)?.reason ?? null).toBeNull();
    expect(attempt.state).toBe("accepted");
    // The writer worked in a worktree of plugins/p, not in the live folder.
    expect(env.spawnedAt).toHaveLength(1);
    expect(env.spawnedAt[0]).not.toBe(env.folder);
    expect(env.spawnedAt[0]).not.toContain(env.folder);
    expect(env.hostCalls.find((call) => call.method === "gitCreateWorktree")?.input.basePath).toBe(join(env.folder, "plugins", "p"));
    // The work is a commit on the repository's main, in its checkout inside the umbrella.
    expect(readFileSync(join(env.folder, "plugins", "p", "src", "hello.ts"), "utf8")).toBe("export const hello = \"hello\";\n");
    expect(git(join(env.folder, "plugins", "p"), "log", "--oneline").split("\n").length).toBeGreaterThan(1);
    expect(git(join(env.folder, "plugins", "p"), "status", "--porcelain")).toBe("");
    // The umbrella's own files were never snapshotted as a live folder.
    expect(env.hostCalls.some((call) => call.method === "runCommand" && String(call.input.command).includes("too_large_output"))).toBe(false);
    await env.harness.lifecycle.dispose();
  });

  it("keeps a task over two repositories in the live folder, as before", async () => {
    const env = await setup((workspace) => {
      put(workspace, "plugins/p/src/hello.ts", "export const hello = \"hello\";\n");
      return "Changed plugins/p/src/hello.ts";
    });
    const sent = await env.dispatch({ owns_paths: ["plugins/p/src/", "plugins/q/src/"], never_touch: [], read_first: [] });
    expect(JSON.stringify(sent.warnings ?? [])).toContain("mode live-folder");
    expect((getTask(env.db, "p-hello")!.contract as TaskV2).project_cwd).toBe(env.folder);
    const attempt = await env.finished();
    expect(attempt.state).toBe("accepted");
    expect(env.spawnedAt).toEqual([env.folder]);
    await env.harness.lifecycle.dispose();
  });

  it("refuses a project_cwd outside the run folder or one that is no repository top", async () => {
    const env = await setup(() => "nothing");
    const outside = await env.dispatch({ project_cwd: "/somewhere/else" });
    expect(outside).toMatchObject({ state: "rejected" });
    const notTop = await env.dispatch({ project_cwd: join(env.folder, "plugins", "p", "src"), owns_paths: ["hello.ts"], expected_outputs: ["hello.ts"], read_first: [], never_touch: [] });
    expect(notTop).toMatchObject({ state: "rejected" });
    await env.harness.lifecycle.dispose();
  });
});
