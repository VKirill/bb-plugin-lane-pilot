import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import * as handlers from "../src/rooms/host-worker/host-handlers";
import type { TaskV2 } from "../src/rooms/contracts";
import { createRun, getAttempt, getTask, getTaskPlan, listAttemptsForTask, listStageReceipts, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../src/rooms/plugin-db";

const projectId = "project-monorepo";
const pmThreadId = "pm-mono";
const runId = "run-mono";
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
  const root = mkdtempSync(join(tmpdir(), "lane-pilot-mono-"));
  roots.push(root);
  put(root, "sdk/src/lib.ts", "export const lib = \"old\";\n");
  put(root, "bot/src/main.ts", "export const main = \"old\";\n");
  put(root, "bot/README.md", "bot\n");
  put(root, "other_bot/src/main.ts", "export const other = 1;\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  // The chat of the section «bot»: its run folder is a subfolder of the repository.
  const folder = join(root, "bot");
  const config = {
    projectId, hostId: "host-mono", pmWorkspacePath: folder, writerWorkspacePath: folder,
    pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test",
  };
  // As the PM wrote it on 2026-10-10: from the umbrella folder, with a reference file of another plugin to read.
  const task: TaskV2 = {
    schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:bot-lib", id: "bot-lib", title: "Change the SDK and the bot", risk: "low", lane: "writer", project_cwd: folder,
    read_first: ["README.md"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"],
    expected_outputs: ["../sdk/src/lib.ts", "src/main.ts"], owns_paths: ["../sdk/src/lib.ts", "src/main.ts"], never_touch: [], depends_on: [],
    objective: "say new", acceptance: ["lib says new"], verify: "none", verification: [{ command: "test -f src/main.ts", cwd: folder, timeout_sec: 60 }],
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
        return { id: "writer-mono" } as never;
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
      get: async () => ({ id: projectId, name: projectId, sources: [{ hostId: "host-mono", path: folder }] }) as never,
      list: async () => [] as never,
    } },
    experimental_callHostRpc: async (call) => {
      const input = call.input as Record<string, unknown>;
      hostCalls.push({ method: call.method, input });
      if (call.method === "classifyPlan") {
        return { hostId: "host-mono", status: "ok", effort: "medium", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
      }
      if (call.method === "diskFree") return { hostId: "host-mono", status: "ok", freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 };
      const handler = (handlers as Record<string, unknown>)[call.method];
      if (typeof handler !== "function") throw new Error(`unexpected host call ${call.method}`);
      return (handler as (input: unknown) => unknown)(input);
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  for (const [key, value] of [["plan_critique.enabled", false], ["memory.enabled", false], ["workspace.provider", false],
    ["integration.gate", "off"], ["docs.enabled", false], ["project_life.enabled", false]] as const) saveProjectSetting(db, projectId, key, value);
  createRun(db, runId, projectId, "bb", folder);
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const dispatch = async (patch: Partial<TaskV2> = {}) => JSON.parse(String(await harness.behavior.callAgentTool(
    "lane_pilot_dispatch_writer", { confirm: true, objective: "Проверка диспетча", plan: "Make hello.ts say hello", task: { ...task, ...patch } }, { threadId: pmThreadId, projectId },
  ))) as Record<string, unknown>;
  const finished = async (taskId = "bot-lib") => {
    for (let i = 0; i < 600; i++) {
      const latest = listAttemptsForTask(db, runId, taskId).at(-1);
      if (latest && !["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(latest.state)
        && !listStageReceipts(db, runId, taskId).some((row) => row.state === "running" || row.state === "pending")) return latest;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the task never finished");
  };
  return { db, harness, folder, root, dispatch, finished, spawnedAt, hostCalls };
}

beforeEach(() => { process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "5000"; });
afterEach(() => {
  delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS;
  process.env.HOME = realHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a section chat's task that also changes files elsewhere in the same repository", () => {
  it("moves to the repository root, works in a worktree of it and merges both the SDK and the bot change into main", async () => {
    const env = await setup((workspace) => {
      put(workspace, "sdk/src/lib.ts", "export const lib = \"new\";\n");
      put(workspace, "bot/src/main.ts", "export const main = \"new\";\n");
      return "Changed sdk/src/lib.ts and bot/src/main.ts";
    });
    const sent = await env.dispatch();
    expect(String(sent.reason ?? "")).toBe("");
    // The report to the section's chat names the files outside the section.
    expect(JSON.stringify(sent.warnings ?? [])).toContain("repo_scope");
    expect(JSON.stringify(sent.warnings ?? [])).toContain("sdk/src/lib.ts");
    const stored = getTask(env.db, "bot-lib")!.contract as TaskV2;
    expect(stored).toMatchObject({ project_cwd: env.root, repo_scope: true, owns_paths: ["sdk/src/lib.ts", "bot/src/main.ts"],
      expected_outputs: ["sdk/src/lib.ts", "bot/src/main.ts"], read_first: ["bot/README.md"],
      // the check keeps the section's folder
      verification: [{ command: "test -f src/main.ts", cwd: join(env.root, "bot") }] });
    expect(getTaskPlan(env.db, "bot-lib")).toContain("Outside the section you may change only: sdk/src/lib.ts");
    const attempt = await env.finished();
    expect(getAttempt(env.db, attempt.id)?.reason ?? null).toBeNull();
    expect(attempt.state).toBe("accepted");
    expect(env.hostCalls.find((call) => call.method === "gitCreateWorktree")?.input.basePath).toBe(env.root);
    expect(env.spawnedAt[0]).not.toContain(env.root);
    expect(readFileSync(join(env.root, "sdk", "src", "lib.ts"), "utf8")).toBe("export const lib = \"new\";\n");
    expect(readFileSync(join(env.root, "bot", "src", "main.ts"), "utf8")).toBe("export const main = \"new\";\n");
    // (bot/.agents is the run folder's own bookkeeping, not the task's work)
    expect(git(env.root, "status", "--porcelain", "--", "sdk", "bot/src", "bot/README.md")).toBe("");
    await env.harness.lifecycle.dispose();
  });

  it("still stops a writer that touches another section of the repository", async () => {
    let blocked = "";
    const env = await setup((workspace) => {
      put(workspace, "sdk/src/lib.ts", "export const lib = \"new\";\n");
      // The worktree's ownership barrier makes every file outside owns_paths read-only: the root scope opens only the files the contract names.
      try { put(workspace, "other_bot/src/main.ts", "export const other = 2;\n"); } catch (cause) { blocked = String(cause); }
      return "Changed sdk/src/lib.ts";
    });
    await env.dispatch();
    await env.finished();
    expect(blocked).toMatch(/EACCES|EPERM|read-only/);
    expect(readFileSync(join(env.root, "other_bot", "src", "main.ts"), "utf8")).toBe("export const other = 1;\n");
    await env.harness.lifecycle.dispose();
  });

  it("rejects a file of another repository or outside the git root, as before", async () => {
    const env = await setup(() => "nothing");
    const sent = await env.dispatch({ owns_paths: ["../../elsewhere/x.ts", "src/main.ts"], expected_outputs: ["src/main.ts"] });
    expect(JSON.stringify(sent)).toContain("unsafe ownership path pattern: ../../elsewhere/x.ts");
    expect(getTask(env.db, "bot-lib")).toBeUndefined();
    await env.harness.lifecycle.dispose();
  });

  it("leaves a task that stays in its section where it was, and drops a repo_scope the PM sent", async () => {
    const env = await setup((workspace) => { put(workspace, "src/main.ts", "export const main = \"new\";\n"); return "Changed src/main.ts"; });
    const sent = await env.dispatch({ owns_paths: ["src/main.ts"], expected_outputs: ["src/main.ts"], repo_scope: true });
    expect(String(sent.reason ?? "")).toBe("");
    const stored = getTask(env.db, "bot-lib")!.contract as TaskV2;
    expect(stored.project_cwd).toBe(env.folder);
    expect(stored.repo_scope).toBeUndefined();
    expect(stored.owns_paths).toEqual(["src/main.ts"]);
    await env.finished();
    await env.harness.lifecycle.dispose();
  });

});
