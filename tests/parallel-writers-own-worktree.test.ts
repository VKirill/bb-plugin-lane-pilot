import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import type { TaskV2 } from "../src/contracts";
import { createRun, getAttempt, listGateEvents, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../src/database";
import { createFakeWorktreeHost } from "./own-worktree-host";

// Live sandbox 2026-10-07 (0.1.181): three low-risk tasks dispatched seconds apart ran in the shared project folder and
// rejected each other's files («owns_paths rejected <another task's file>»). Every writer attempt of a git project works in
// its own worktree, so tasks with disjoint owns_paths in one folder are all accepted.
const projectId = "project-parallel";
const pmThreadId = "pm-parallel";
const hostId = "host-parallel";
const folder = "/tmp/parallel-project";
const config = {
  projectId, hostId, pmWorkspacePath: "/tmp/pm", writerWorkspacePath: folder,
  pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test",
};

const taskFor = (id: string): TaskV2 => ({
  schema_version: 2, id, title: `Write ${id}`, risk: "low", lane: "writer", project_cwd: folder,
  read_first: [], interfaces: ["file exists"], invariants: ["only its own file"], out_of_scope: ["other files"],
  expected_outputs: [`${id}.txt`], owns_paths: [`${id}.txt`], never_touch: [".git/**"], depends_on: [],
  objective: `Write ${id}.txt`, acceptance: ["file is present"], verify: "none", verification: [],
});

describe("parallel low-risk writers in one git folder", () => {
  it("each works in its own worktree, so tasks with disjoint owns_paths do not reject each other", async () => {
    const ids = ["lp-one", "lp-two", "lp-three"];
    // What each folder holds that git sees as changed: a writer leaves its file in the folder it was started in.
    const dirt = new Map<string, Map<string, string>>();
    const spawnedIn = new Map<string, string>();
    let writers = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    let allWritten = false;
    const { bb, harness } = createFakeWorktreeHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: "run-parallel" } : { role: "writer" },
          spawn: async (input) => {
            const meta = input.pluginMetadata as Record<string, unknown>;
            const taskId = String(meta.lanePilotTaskId);
            const cwd = String((input.environment as { workspace?: { path?: string } }).workspace?.path ?? "");
            const files = dirt.get(cwd) ?? new Map<string, string>();
            files.set(`${taskId}.txt`, createHash("sha256").update(taskId).digest("hex"));
            dirt.set(cwd, files);
            spawnedIn.set(taskId, cwd);
            writers += 1;
            // The three writers overlap in time: none is done before all three have started and written.
            if (writers === ids.length) { allWritten = true; release(); }
            return { id: `writer-${taskId}` };
          },
          wait: async () => { await together; return { matched: true, thread: { status: "idle" } }; },
          get: async ({ threadId }) => threadId === pmThreadId
            ? { id: pmThreadId, status: "idle", projectId, sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId }
            : { id: threadId, status: allWritten ? "idle" : "active" },
          output: async () => ({ text: "writer output" }),
          list: async () => [] as never,
        },
        providers: {
          list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
          models: async () => ({ models: [{ id: "codex-test", model: "codex-test",
            supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
        },
        files: {
          read: async ({ path }) => ({ content: path.endsWith(".txt") ? "content\n" : null }),
          write: async () => ({ ok: true }),
        },
      },
      experimental_callHostRpc: (call) => {
        if (call.method === "gitOwnershipBase") {
          return { hostId, status: "not-git" as const, branch: null, headSha: null, baseRef: null, baseSha: null, compareCommitted: false, reason: "synthetic fixture" };
        }
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        const input = call.input as { cwd?: string; command?: string };
        if (!String(input.command ?? "").includes("porcelain")) return { hostId, exitCode: 0, stdout: "", stderr: "" };
        const files = dirt.get(String(input.cwd ?? "")) ?? new Map<string, string>();
        return { hostId, exitCode: 0, stdout: JSON.stringify([...files].map(([path, sha256]) => ({ path, sha256 }))), stderr: "" };
      },
    }, hostId);
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "plan_critique.enabled", false);
    saveProjectSetting(db, projectId, "memory.enabled", false);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    createRun(db, "run-parallel", projectId, "bb", folder);
    setRunThread(db, "run-parallel", pmThreadId);
    await plugin(bb);

    const dispatched = [];
    for (const id of ids) {
      dispatched.push(JSON.parse(String(await harness.behavior.callAgentTool(
        "lane_pilot_dispatch_writer",
        { confirm: true, plan: `Write ${id}.txt and nothing else`, task: taskFor(id) },
        { threadId: pmThreadId, projectId },
      ))) as { attemptId: string });
    }
    const waited = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId: "run-parallel", timeoutSec: 10 }, { threadId: pmThreadId, projectId },
    )));
    expect(waited.state, JSON.stringify(waited)).toBe("accepted");

    for (const row of dispatched) {
      expect(getAttempt(db, row.attemptId)).toMatchObject({ state: "accepted" });
    }
    // Not one rejection by another task's file.
    expect(listGateEvents(db, { projectId, since: 0 }).filter((event) => event.status === "rejected")).toEqual([]);
    // Three attempts, three different folders, none of them the shared project folder.
    expect(writers).toBe(ids.length);
    const places = ids.map((id) => spawnedIn.get(id));
    expect(new Set(places).size).toBe(ids.length);
    expect(places).not.toContain(folder);
    const decisions = dispatched.map((row) => getAttempt(db, row.attemptId)?.workspace_decision);
    expect(decisions.every((decision) => (decision as { strategy?: string } | null)?.strategy === "provision_attempt_worktree")).toBe(true);
    await harness.lifecycle.dispose();
  }, 30_000);
});
