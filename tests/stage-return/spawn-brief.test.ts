import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, openDatabase, setRunThread } from "../../src/rooms/storage/database";
import { insertReturn } from "../../src/rooms/stage-return/store";
import { createWriterSpawn } from "../../src/rooms/writer/server/spawn";

// A task a person sent back to an earlier stage with a note: the writer's first brief carries the note, right after the role line.
describe("the writer brief of a returned task", () => {
  const folder = "/repo/apps/bot";
  const config: PrototypeConfig = { projectId: "P", hostId: "h", pmWorkspacePath: folder, writerWorkspacePath: folder,
    pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test" };
  const task: TaskV2 = {
    schema_version: 2, id: "t1", title: "Write the bot", risk: "high", lane: "writer", project_cwd: folder, read_first: [], interfaces: [],
    invariants: [], out_of_scope: [], expected_outputs: ["index.ts"], owns_paths: ["index.ts"], never_touch: [], depends_on: [],
    objective: "edit the bot", acceptance: ["files exist"], verify: "none", verification: [],
  };

  async function firstBrief(withNote: boolean, continuation: { workspacePath: string; environmentId: null; dirtBefore: []; fromThreadId: string; brief: string }) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", folder);
    setRunThread(db, "run", "pm");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    if (withNote) insertReturn(db, { id: "rtn_1", at: Date.UTC(2026, 9, 22, 12, 0, 0), projectId: "P", runId: "run", taskId: "t1", attemptId: null, to: "writer", from: "writer-agent", by: "owner",
      note: "Use the existing csv helper in lib/csv.ts.", reused: [], stale: [] });
    const spawned: Array<{ input: Array<{ text: string }> }> = [];
    const ctx = {
      bb: {
        storage: bb.storage, log: { info() {}, warn() {} },
        sdk: {
          projects: { get: async () => ({ sources: [] }) },
          providers: {
            list: async () => [{ id: "codex", available: true, serviceTiers: [{ id: "default" }] }],
            models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }),
          },
          files: { read: async () => ({ content: null }) },
          threads: {
            get: async () => ({ id: "pm", projectId: "P", status: "idle" }),
            spawn: async (args: { input: Array<{ text: string }> }) => { spawned.push(args); return { id: "writer-1" }; },
          },
        },
      },
      db,
      host: { call: async (method: string) => (method === "runCommand" ? { hostId: "h", exitCode: 0, stdout: "[]", stderr: "" } : {}) },
      effectiveProjectSettings: async () => ({ values: { "jev.LANE_JEV_EFFORT": false, "memory.enabled": false, "adoc.040": "auto" } }),
    };
    const writer = createWriterSpawn(ctx as never, { providerBreaker: { decide: () => ({ allow: true }) }, ruleScan: { chainForRun: async () => [] } } as never);
    const result = await writer.spawnWriterAttempt({ projectId: "P", runId: "run", taskId: "t1", attemptId: "a1", config, task, plan: "write", pmThreadId: "pm",
      emergency: { providerId: "codex", model: "codex-test", reason: "reassigned by the PM" }, ...(continuation ? { continuation } : {}) });
    expect(result.ok).toBe(true);
    return spawned[0]!.input.map((part) => part.text).join("\n");
  }

  const handoff = { workspacePath: "/wt/a0", environmentId: null, dirtBefore: [] as [], fromThreadId: "thr_w", brief: "HANDOFF BRIEF: index.ts is written" };

  it("carries the note word for word with who and when, after the role line", async () => {
    const brief = await firstBrief(true, handoff);
    expect(brief).toContain("Use the existing csv helper in lib/csv.ts.");
    expect(brief).toContain('<return_note stage="writer" by="owner" at="2026-10-22T12:00:00.000Z">');
    expect(brief.indexOf("You are Lane Pilot writer")).toBeLessThan(brief.indexOf("Use the existing csv helper"));
  });

  it("puts it after the handoff of a reassigned writer, so the new writer reads both", async () => {
    const brief = await firstBrief(true, handoff);
    expect(brief.indexOf("HANDOFF BRIEF")).toBeLessThan(brief.indexOf("Use the existing csv helper"));
  });

  it("adds nothing to a task that was never returned", async () => {
    expect(await firstBrief(false, handoff)).not.toContain("return_note");
  });
});
