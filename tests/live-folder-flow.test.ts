import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { runCommandOnHost } from "../src/cli-run";
import { snapshotDryRun } from "../src/host-handlers";
import type { TaskV2 } from "../src/contracts";
import {
  createRun, getAttempt, listAttemptsForTask, listStageReceipts, loadProjectSettings, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread,
} from "../src/database";

const projectId = "project-live";
const pmThreadId = "pm-live";
const runId = "run-live";
const realHome = process.env.HOME;
const roots: string[] = [];

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `lane-pilot-${prefix}-`));
  roots.push(root);
  return root;
}

/** Paths the fake writer edited: its thread shows them as file changes, as a real writer thread does. */
const touched: string[] = [];

function write(root: string, path: string, content: string): void {
  touched.push(path);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/**
 * The whole plugin on a plain folder (no git anywhere): dispatch, the writer thread edits real files, Lane Pilot
 * validates and accepts or rolls back. The host answers runCommand for real and fails the test on any other git call.
 */
async function setup(writerEdits: (folder: string) => string, feedback: (folder: string, turn: number) => string = () => "Looked again") {
  const home = temp("home");
  process.env.HOME = home;
  const folder = temp("folder");
  write(folder, "hello.txt", "original\n");
  write(folder, "keep/other.txt", "not owned\n");
  const config = {
    projectId, hostId: "host-live", pmWorkspacePath: folder, writerWorkspacePath: folder,
    pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test",
  };
  const task: TaskV2 = {
    schema_version: 2, id: "live-task", title: "Edit the live files", risk: "low", lane: "writer", project_cwd: folder,
    read_first: [], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["hello.txt"],
    owns_paths: ["hello.txt", "src/**"], never_touch: [], depends_on: [], objective: "greet", acceptance: ["hello.txt says hello"],
    verify: "none", verification: [],
  };
  const hostCalls: string[] = [];
  const commands: string[] = [];
  const writes = new Map<string, string>();
  const threadSpawns: Array<{ role?: unknown }> = [];
  let answer = "";
  const events: unknown[] = [];
  const feedbackSeen: string[] = [];
  let seq = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: {
      getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : { role: "writer" },
      spawn: async (args) => {
        const role = (args as { pluginMetadata?: { role?: unknown } }).pluginMetadata?.role;
        threadSpawns.push({ role });
        // The writer's work: real edits of the live files, made after Lane Pilot snapshotted and backed up the folder.
        if (role === "writer") answer = writerEdits(folder);
        return { id: "writer-live" } as never;
      },
      get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId }) as never,
      output: async () => ({ text: answer }),
      list: async () => [] as never,
      context: async () => ({ usage: null }) as never,
      updatePluginMetadata: async () => ({}) as never,
      // A feedback turn: the same writer thread gets the failure, works on the live files again and finishes its turn.
      send: async ({ threadId, input }) => {
        if (threadId !== "writer-live") return undefined;
        feedbackSeen.push(readFileSync(join(folder, "hello.txt"), "utf8"));
        answer = feedback(folder, feedbackSeen.length);
        events.push({ type: "client/turn/requested", seq: seq += 1, createdAt: Date.now() },
          { type: "turn/started", threadId, seq: seq += 1, data: {} },
          { type: "turn/completed", threadId, seq: seq += 1, data: { status: "completed" } });
        void input;
        return undefined;
      },
      events: { list: async () => [...events, { type: "item/completed", data: { item: { type: "fileChange", changes: touched.map((path) => ({ path })) } } }] as never },
    }, providers: {
      list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
      models: async () => ({ models: [{ id: "codex-test", model: "codex-test",
        supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
    }, files: {
      read: async () => ({ content: "fixture\n" }),
      listPaths: async () => ({ paths: [] }) as never,
      write: async (args) => { writes.set((args as { path: string }).path, (args as { content: string }).content); return { ok: true } as never; },
    } },
    experimental_callHostRpc: async (call) => {
      hostCalls.push(call.method);
      if (call.method === "classifyPlan") {
        return { hostId: "host-live", status: "ok", effort: "medium", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
      }
      // The contract lint asks the machine about read_first files; that is the host's own file check, no git.
      if (call.method === "snapshotDryRun") return snapshotDryRun(call.input as never, {} as never);
      if (call.method !== "runCommand") throw new Error(`a folder without git must not call ${call.method}`);
      const input = call.input as { requestedHostId: string; command: string; cwd: string; timeoutSec?: number };
      commands.push(input.command);
      return runCommandOnHost(input);
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  saveProjectSetting(db, projectId, "plan_critique.enabled", false);
  saveProjectSetting(db, projectId, "memory.enabled", false);
  saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
  createRun(db, runId, projectId, "bb", folder);
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const dispatch = async (patch: Partial<TaskV2> = {}) => JSON.parse(String(await harness.behavior.callAgentTool(
    "lane_pilot_dispatch_writer", { confirm: true, plan: "Make hello.txt say hello", task: { ...task, ...patch } }, { threadId: pmThreadId, projectId },
  ))) as Record<string, unknown>;
  const finished = async () => {
    for (let i = 0; i < 400; i++) {
      const latest = listAttemptsForTask(db, runId, "live-task").at(-1);
      if (latest && !["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(latest.state)
        && !listStageReceipts(db, runId, "live-task").some((row) => row.state === "running" || row.state === "pending")) return latest;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the task never finished");
  };
  return { db, harness, folder, home, dispatch, finished, hostCalls, commands, writes, threadSpawns, feedbackSeen };
}

beforeEach(() => { process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "5000"; });
afterEach(() => {
  delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS;
  process.env.HOME = realHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a plain folder without git, end to end", () => {
  it("dispatches, lets the writer edit the live files, accepts, and never touches git, a worktree or a merge", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      write(folder, "src/new.ts", "export {};\n");
      return "Changed hello.txt and src/new.ts";
    });
    const sent = await env.dispatch();
    expect(sent).toMatchObject({ state: "queued" });
    expect(JSON.stringify(sent.warnings)).toContain("mode live-folder");
    const attempt = await env.finished();
    expect(attempt.state).toBe("accepted");
    const bound = getAttempt(env.db, attempt.id)!;
    // In place: the attempt's workspace is the run's folder, decided as a live folder.
    expect(bound.workspace_path).toBe(env.folder);
    expect(bound.environment_id).toBeNull();
    expect(bound.workspace_decision).toMatchObject({ strategy: "inherit_run", reason: "live_folder" });
    // The files are already in place; nothing was committed, merged or branched.
    expect(readFileSync(join(env.folder, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(env.folder, "src", "new.ts"))).toBe(true);
    expect(existsSync(join(env.folder, ".git"))).toBe(false);
    noGit(env);
    expect(env.threadSpawns.filter((row) => row.role === "writer")).toHaveLength(1);
    // The receipt names the mode.
    const receipt = [...env.writes].find(([path]) => path.endsWith("lane-pilot-receipt.json"));
    expect(receipt && JSON.parse(receipt[1])).toMatchObject({ status: "accepted", workspace: "live-folder", ownsPaths: ["hello.txt", "src/**"] });
    expect(loadProjectSettings(env.db, projectId)["writer.lastResult"]).toMatchObject({ workspace: "live-folder" });
    const writerStage = listStageReceipts(env.db, runId, "live-task").find((row) => row.stageId === "writer-agent")!;
    expect(writerStage.result).toMatchObject({ status: "accepted", workspace: { mode: "live-folder" } });
    expect((writerStage.result as { produced?: string[] }).produced?.slice().sort()).toEqual(["hello.txt", "src/new.ts"]);
    await env.harness.lifecycle.dispose();
  });

  it("does not blame the writer for a file the PM or the owner changed in the folder meanwhile (live drill 2026-10-07)", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      // Someone else edits the shared folder during the attempt: no write() call, so the writer's thread never shows it.
      writeFileSync(join(folder, "notes-by-pm.md"), "the PM was here\n");
      return "Changed hello.txt";
    });
    await env.dispatch();
    const attempt = await env.finished();
    expect(attempt.state).toBe("accepted");
    expect(readFileSync(join(env.folder, "notes-by-pm.md"), "utf8")).toBe("the PM was here\n");
    await env.harness.lifecycle.dispose();
  });

  it("keeps the contract lint working: read_first is checked on the folder's machine, a missing file goes back to the PM", async () => {
    const env = await setup(() => "nothing");
    const missing = await env.dispatch({ read_first: ["nowhere/missing.txt"] });
    expect(missing).toMatchObject({ state: "validation_failed", findings: [{ code: "read_first_missing" }] });
    expect(env.threadSpawns).toEqual([]);
    const present = await env.dispatch({ read_first: ["keep/other.txt"] });
    expect(present).toMatchObject({ state: "queued" });
    expect(present.findings).toBeUndefined();
    await env.finished();
    expect(env.hostCalls).toContain("snapshotDryRun");
    await env.harness.lifecycle.dispose();
  });

  it("rolls the owned files back when the attempt is rejected, and leaves what is outside owns_paths", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "changed, then rejected\n");
      write(folder, "src/created.ts", "created by the writer\n");
      // Outside owns_paths: the attempt is rejected for it, and it is not rolled back (only owned paths are).
      write(folder, "keep/other.txt", "touched by the writer\n");
      return "Changed things";
    });
    await env.dispatch();
    const attempt = await env.finished();
    expect(attempt.state).not.toBe("accepted");
    expect(String(getAttempt(env.db, attempt.id)?.reason ?? "")).toContain("keep/other.txt");
    expect(readFileSync(join(env.folder, "hello.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(env.folder, "src", "created.ts"))).toBe(false);
    expect(readFileSync(join(env.folder, "keep", "other.txt"), "utf8")).toBe("touched by the writer\n");
    // Never rm: the created file sits in the backup folder, beside the originals, for seven days.
    const backups = join(env.home, ".lane-pilot", "live-backups");
    const ids = readdirSync(backups);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => existsSync(join(backups, id, "created", "src", "created.ts")))).toBe(true);
    noGit(env);
    await env.harness.lifecycle.dispose();
  });

  it("keeps the live files across a feedback turn, and accepts once the writer fixes what was rejected", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      write(folder, "keep/other.txt", "touched by the writer\n");
      return "Changed things";
    }, (folder) => {
      // The writer undoes its stray edit in the same thread, on the same live files.
      write(folder, "keep/other.txt", "not owned\n");
      return "Undid keep/other.txt";
    });
    await env.dispatch();
    const attempt = await env.finished();
    expect(attempt.state).toBe("accepted");
    // The feedback turn found the first turn's edit still in place: nothing was rolled back between turns.
    expect(env.feedbackSeen).toEqual(["hello\n"]);
    expect(env.threadSpawns.filter((row) => row.role === "writer")).toHaveLength(1);
    expect(readFileSync(join(env.folder, "hello.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(env.folder, "keep", "other.txt"), "utf8")).toBe("not owned\n");
    noGit(env);
    await env.harness.lifecycle.dispose();
  });
});

/** The folder has no git: Lane Pilot asked once whether there is a repository and ran no git step, no worktree, no merge. */
function noGit(env: Awaited<ReturnType<typeof setup>>): void {
  expect(env.hostCalls.filter((method) => /^git/.test(method))).toEqual([]);
  expect(env.commands.filter((command) => /^git\b/.test(command))).toEqual(["git rev-parse --is-inside-work-tree"]);
}
