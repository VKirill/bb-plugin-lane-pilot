import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, setRunThread } from "../src/rooms/storage/database";
import { createWriterSpawn } from "../src/rooms/writer/server/spawn";
import { HANDOFF_BRIEF_MAX_CHARS, buildHandoffBrief, collectHandoffBrief } from "../src/rooms/writer/server/writer-handoff";

const INSTRUCTION = "Do not start over; review them, finish the remaining work, run the checks, end with your summary.";

const command = (text: string, exitCode: number, output: string) => ({ data: { item: { type: "commandExecution", command: text, exitCode, aggregatedOutput: output } } });
const message = (text: string) => ({ data: { item: { type: "agentMessage", text } } });

describe("handoff brief", () => {
  it("carries the stop reason, the workspace status, the failing command's tail and the continue instruction", () => {
    const brief = buildHandoffBrief({
      stopReason: "provider_error: writer_provider_limit: plan spent",
      gitStatus: " M src/parser.ts\n?? src/new.ts\n 2 files changed",
      // Newest first, as the thread lists them.
      events: [
        message("Parser fixed; running the checks now"),
        command("npm test -- parser", 1, `${"noise ".repeat(500)}AssertionError: parser boom`),
        command("git status", 0, "clean"),
        message("Reading the parser"),
      ],
    });
    expect(brief).toContain(INSTRUCTION);
    expect(brief).toContain("You are continuing an interrupted session of this task.");
    expect(brief).toContain("Stop reason: provider_error: writer_provider_limit: plan spent");
    expect(brief).toContain(" M src/parser.ts");
    expect(brief).toContain("Last failing command (exit 1): npm test -- parser");
    expect(brief).toContain("AssertionError: parser boom");
    expect(brief).not.toContain("Last failing command (exit 0)");
    expect(brief.indexOf("Parser fixed")).toBeLessThan(brief.indexOf("Reading the parser"));
  });

  it("says so when no command failed and the workspace is clean", () => {
    const brief = buildHandoffBrief({ stopReason: "provider_error: x", gitStatus: "  ", events: [command("ls", 0, "a")] });
    expect(brief).toContain("Last failing command: none in the thread's events.");
    expect(brief).toContain("(no uncommitted changes)");
  });

  it("stays within its size bound and keeps the instruction when the thread and workspace are large", () => {
    const events = Array.from({ length: 50 }, (_, index) => message(`message ${index} ${"x".repeat(5_000)}`));
    const brief = buildHandoffBrief({ stopReason: "provider_error: limit", gitStatus: " M a.ts\n".repeat(20_000), events });
    expect(brief.length).toBeLessThanOrEqual(HANDOFF_BRIEF_MAX_CHARS);
    expect(brief).toContain(INSTRUCTION);
    expect(brief).toContain("Stop reason: provider_error: limit");
  });

  it("reads the thread and the workspace on the host, and still gives the instruction when the thread cannot be listed", async () => {
    const calls: string[] = [];
    const bb = { sdk: { threads: { events: { list: async (query: { types?: unknown }) => {
      calls.push("events");
      if (query.types) return [];
      throw new Error("events unavailable");
    } } } } };
    const host = { call: async (method: string) => {
      calls.push(method);
      return { exitCode: 0, stdout: " M src/parser.ts\n", stderr: "" };
    } };
    const brief = await collectHandoffBrief({ bb: bb as never, host: host as never, hostId: "h1", threadId: "thr_w",
      workspacePath: "/wt/T1-a1", stopReason: "provider_error: limit" });
    expect(calls).toEqual(["events", "runCommand"]);
    expect(brief).toContain(" M src/parser.ts");
    expect(brief).toContain("Last failing command: none in the thread's events.");
    expect(brief).toContain(INSTRUCTION);
  });
});

describe("fallback spawn with a continuation", () => {
  const folder = "/repo/apps/bot";
  const interrupted = "/wt/a0";
  const config: PrototypeConfig = { projectId: "P", hostId: "h", pmWorkspacePath: folder, writerWorkspacePath: folder,
    pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test" };
  const task: TaskV2 = {
    schema_version: 2, id: "t1", title: "Write the bot", risk: "high", lane: "writer", project_cwd: folder, read_first: [], interfaces: [],
    invariants: [], out_of_scope: [], expected_outputs: ["index.ts"], owns_paths: ["index.ts"], never_touch: [], depends_on: [],
    objective: "edit the bot", acceptance: ["files exist"], verify: "none", verification: [],
  };

  it("starts the fallback in the interrupted worktree, with its baseline and the brief after the role line, and no new worktree", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", folder);
    setRunThread(db, "run", "pm");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    const hostCalls: string[] = [];
    const spawned: Array<{ input: Array<{ text: string }> }> = [];
    const ctx = {
      bb: {
        storage: bb.storage,
        log: { info() {}, warn() {} },
        sdk: {
          projects: { get: async () => ({ sources: [] }) },
          providers: {
            list: async () => [{ id: "codex", available: true, serviceTiers: [{ id: "default" }] }],
            models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }),
          },
          files: { read: async () => ({ content: null }) },
          threads: {
            get: async () => ({ id: "pm", projectId: "P", status: "idle" }),
            spawn: async (args: { input: Array<{ text: string }> }) => { spawned.push(args); return { id: "writer-fallback" }; },
          },
        },
      },
      db,
      host: {
        call: async (method: string) => {
          hostCalls.push(method);
          if (method === "runCommand") return { hostId: "h", exitCode: 0, stdout: "[]", stderr: "" };
          return {};
        },
      },
      effectiveProjectSettings: async () => ({ values: { "jev.LANE_JEV_EFFORT": false, "memory.enabled": false, "adoc.040": "auto" } }),
    };
    const writer = createWriterSpawn(ctx as never, { providerBreaker: { decide: () => ({ allow: true }) }, ruleScan: { chainForRun: async () => [] } } as never);
    const result = await writer.spawnWriterAttempt({
      projectId: "P", runId: "run", taskId: "t1", attemptId: "a1", config, task, plan: "write", pmThreadId: "pm",
      emergency: { providerId: "codex", model: "codex-test", reason: "primary_provider_error" },
      continuation: { workspacePath: interrupted, environmentId: null, dirtBefore: [{ path: "stray.txt", sha256: "baseline" }],
        fromThreadId: "thr_w", brief: "HANDOFF BRIEF: index.ts is written; finish the check" },
    });
    expect(result).toMatchObject({ ok: true, workspacePath: interrupted, dirtBefore: [{ path: "stray.txt", sha256: "baseline" }] });
    expect(getAttempt(db, "a1")?.workspace_path).toBe(interrupted);
    expect(hostCalls).not.toContain("gitCreateWorktree");
    expect(hostCalls).not.toContain("gitPrepareWorktree");
    const first = spawned[0]!.input.map((part) => part.text).join("\n");
    expect(first).toContain("HANDOFF BRIEF: index.ts is written; finish the check");
    expect(first.indexOf("You are Lane Pilot writer")).toBeLessThan(first.indexOf("HANDOFF BRIEF"));
    expect(first).not.toContain("Its work is not guaranteed to be here");
  });
});
