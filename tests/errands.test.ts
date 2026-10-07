import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { runCommand } from "../src/host-handlers";
import { createRun, openDatabase, setRunThread } from "../src/database";
import { errandPrompt } from "../src/server/errands";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("errandPrompt", () => {
  it("never lets the helper change, commit or push repository files; it stops with ERRAND: blocked", () => {
    for (const authorized of [false, true]) {
      const prompt = errandPrompt({ task: "Update .gitignore for me", browserHostId: null, authorized });
      expect(prompt).toContain("Never change, commit or push this repository's files");
      expect(prompt).toContain("`git add`/`git commit`/`git push`");
      expect(prompt).toContain("ERRAND: blocked");
    }
  });

  it("wait_errand returns blocked repo_edited with the changed files when a helper edited the repo", async () => {
    const projectId = "errand-test-project";
    const pmThreadId = "errand-pm-thread";
    const runId = "errand-run-id";
    const spawned: Array<Record<string, unknown>> = [];
    const hostCalls: Array<{ method: string; hostId: unknown; cwd: unknown }> = [];

    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      // The PM's checkout is on host "local-host": its status is read there (here that is this machine), never by the hub.
      experimental_callHostRpc: (async (call: { method: string; input: { requestedHostId: string; cwd: string } }) => {
        hostCalls.push({ method: call.method, hostId: call.input.requestedHostId, cwd: call.input.cwd });
        if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
        throw new Error(`unexpected ${call.method}`);
      }) as never,
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : {},
          spawn: async (args) => { spawned.push(args as unknown as Record<string, unknown>); return { id: "errand-child-thread" }; },
          get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId, environmentId: "env-pm", sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId }),
          events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
          output: async () => ({ output: "I updated .gitignore\nERRAND: done" }),
        },
        environments: {
          get: async () => ({ id: "env-pm", hostId: "local-host", path: process.cwd(), status: "ready" }),
        },
      },
    });

    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    createRun(db, runId, projectId, "cli");
    setRunThread(db, runId, pmThreadId);

    const call = async (name: string, params: Record<string, unknown>) =>
      JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: pmThreadId, projectId }))) as Record<string, any>;

    const started = await call("lane_pilot_errand", { task: "Please update .gitignore file for me" });
    expect(started).toMatchObject({ threadId: "errand-child-thread", state: "running" });

    // Create a temporary untracked file to simulate a helper edit
    const fs = await import("node:fs/promises");
    const testFile = "stray_helper_test_file.txt";
    await fs.writeFile(testFile, "touched");
    try {
      const waited = await call("lane_pilot_wait_errand", { threadId: "errand-child-thread", timeoutSec: 5 });
      expect(waited).toMatchObject({
        threadId: "errand-child-thread",
        state: "blocked",
        reason: "repo_edited",
        files: expect.arrayContaining([testFile]),
      });
      expect(hostCalls.length).toBeGreaterThanOrEqual(2);
      expect(hostCalls.every((call) => call.method === "runCommand" && call.hostId === "local-host" && call.cwd === process.cwd())).toBe(true);
    } finally {
      await fs.unlink(testFile).catch(() => undefined);
    }
  });

  it("errandPrompt and tools reflect the goal-based authorization policy without 'exactly that change'", () => {
    const prompt = errandPrompt({ task: "Setup DNS and configure site", browserHostId: null, authorized: true });
    expect(prompt).toContain("Authorization follows the owner's goal");
    expect(prompt).toContain("every reversible step needed for the approved outcome inside the owner's accounts is authorized");
    expect(prompt).not.toContain("exactly that change");

    const readOnlyPrompt = errandPrompt({ task: "Inspect DNS", browserHostId: null, authorized: false });
    expect(readOnlyPrompt).toContain("Read and report only");
  });
});
