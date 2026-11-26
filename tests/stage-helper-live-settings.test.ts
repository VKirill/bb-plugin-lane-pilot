import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { stageHelperSettings } from "../src/rooms/settings/server/services/stage-settings";
import { LP_DEFAULTS_KEY } from "@lane-pilot/settings-catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { runPmRead } from "../src/rooms/critique/server";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, openTaskHome, recordTaskFile, saveProjectSetting, setRunThread } from "../src/rooms/plugin-db";
import { bbTaskFileIo } from "../src/rooms/storage";
import { createWriterSticky } from "../src/rooms/writer/server/services/sticky";

vi.mock("@lane-pilot/thread-observe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lane-pilot/thread-observe")>()),
  waitThreadIdle: async () => undefined,
}));

const PROJECT = "P";
/** The run's frozen snapshot: the writer model it started with. */
const config: PrototypeConfig = {
  projectId: PROJECT, hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo",
  pmProviderId: "codex", pmModel: "model-a", writerProviderId: "codex", writerModel: "model-a",
};
const task: TaskV2 = {
  schema_version: 2, id: "t1", title: "Write", risk: "low", lane: "writer", project_cwd: "/repo", read_first: ["notes.md"],
  interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [],
  depends_on: [], objective: "write", acceptance: ["file exists"], verify: "none", verification: [],
};
const notes = Array.from({ length: 60 }, (_, line) => `note line ${line + 1}`).join("\n");

const model = (id: string) => ({ id, model: id, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] });

/** A project whose run is open, with a fake host that records every helper spawn. */
function pmReadWorld() {
  const spawned: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const packetFiles = new Map<string, string>();
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    // read_first's windowless probe reads a bounded slice through the host contract before the
    // whole-file SDK read; serve it over the same notes content files.read returns.
    experimental_callHostRpc: async (call) => {
      if (call.method !== "readBoundedFile") throw new Error(`unexpected host method ${call.method}`);
      const input = call.input as { relativePath: string; offset: number; maxLines: number };
      const lines = notes.split("\n");
      const selected = lines.slice(input.offset, input.offset + input.maxLines);
      const content = selected.join("\n");
      return {
        schemaVersion: 1, hostId: "h", path: input.relativePath, content, contentEncoding: "utf8",
        sha256: createHash("sha256").update(notes).digest("hex"),
        sizeBytes: Buffer.byteLength(notes), totalLines: lines.length,
        offset: input.offset, maxLines: input.maxLines,
        lineStart: input.offset + 1,
        lineEnd: selected.length === 0 ? input.offset : input.offset + selected.length,
        truncated: input.offset + selected.length < lines.length,
        returnedBytes: Buffer.byteLength(content),
      };
    },
    sdk: {
      files: {
        // The pm-read packet materializes big inputs under .agents/runs/<run>/inputs/ before the spawn: path-aware store.
        read: async ({ path }: { path?: string }) => {
          reads.push(String(path));
          const stored = path ? packetFiles.get(path) : undefined;
          if (stored !== undefined) return { content: stored, contentEncoding: "utf8" };
          return { content: notes, contentEncoding: "utf8", sha256: "f".repeat(64), sizeBytes: notes.length };
        },
        write: async ({ path, content }: { path: string; content: string }) => { packetFiles.set(path, content); return { outcome: "written" }; },
      },
      providers: {
        list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }],
        models: async () => ({ models: [model("model-a"), model("model-b")] }),
      },
      threads: {
        get: async () => ({ status: "idle", projectId: PROJECT }),
        spawn: async (args: Record<string, unknown>) => { spawned.push(args); return { id: "pm-read-1" }; },
        output: async () => ({ output: '{"summary":"Context","keyFacts":["Fact"],"openQuestions":[]}' }),
      },
    } as never,
  });
  const db = openDatabase(bb);
  createRun(db, "run", PROJECT, "cli", "/repo");
  setRunThread(db, "run", "pm-thread");
  createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
  createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
  saveProjectSetting(db, PROJECT, "pm_read.enabled", true);
  saveProjectSetting(db, PROJECT, "pm_read.min_lines", 50);
  const run = (over: Record<string, unknown> = {}) => runPmRead({ stageHelperSettings, bb, db, projectId: PROJECT, runId: "run", taskId: "t1", pmThreadId: "pm-thread", config, task, ...over });
  return { bb, db, spawned, reads, run };
}

describe("stage helper spawns read the settings in effect at spawn time", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pm-read uses the writer default changed after the run's snapshot (model A -> B)", async () => {
    const w = pmReadWorld();
    await w.bb.storage.kv.set(LP_DEFAULTS_KEY, { writerProviderId: "codex", writerModel: "model-b", revision: 1 } as never);
    const result = await w.run();
    expect(result.state).toBe("passed");
    expect(w.spawned).toHaveLength(1);
    expect(w.spawned[0]).toMatchObject({ providerId: "codex", model: "model-b" });
  });

  it("pm-read uses a pm_read.model saved in the project settings", async () => {
    const w = pmReadWorld();
    saveProjectSetting(w.db, PROJECT, "pm_read.model", "model-b");
    const result = await w.run();
    expect(result.state).toBe("passed");
    expect(w.spawned[0]).toMatchObject({ providerId: "codex", model: "model-b" });
  });

  it("does not call a model when both critics are off, including quality_mode quick", async () => {
    const bothOff = pmReadWorld();
    saveProjectSetting(bothOff.db, PROJECT, "plan_critique.enabled", false);
    saveProjectSetting(bothOff.db, PROJECT, "code_critique.enabled", false);
    const skipped = await bothOff.run();
    expect(skipped.state).toBe("skipped");
    expect(bothOff.spawned).toHaveLength(0);
    expect(listStageReceipts(bothOff.db, "run", "t1").find((row) => row.stageId === "pm-read")?.reason).toBe("critics_disabled");

    const quick = pmReadWorld();
    const quickResult = await runPmRead({ stageHelperSettings,
      bb: quick.bb, db: quick.db, projectId: PROJECT, runId: "run", taskId: "t1", pmThreadId: "pm-thread", config,
      task: { ...task, quality_mode: "quick" },
    });
    expect(quickResult.state).toBe("skipped");
    expect(quick.spawned).toHaveLength(0);
    expect(listStageReceipts(quick.db, "run", "t1").find((row) => row.stageId === "pm-read")?.reason).toBe("quality_mode_quick");
  });

  it("a homed task's new PLAN.md revision invalidates the cached scout summary", async () => {
    const w = pmReadWorld();
    openTaskHome(w.db, { taskId: "t1", projectId: PROJECT, runId: "run", basePath: "/repo", hostId: "h" });
    const io = bbTaskFileIo(w.bb as never, "h", "/repo");
    const producer = { node: "dispatch" };
    await recordTaskFile(w.db, io, { taskId: "t1", kind: "plan", name: "PLAN.md", content: "plan v1\n", producer });
    const first = await w.run({ plan: "the plan" });
    expect(first.state).toBe("passed");
    expect(w.spawned).toHaveLength(1);
    // Same input: the cached summary is reused — after the canonical plan verifies, no second spawn.
    const again = await w.run({ plan: "the plan" });
    expect(again.state).toBe("passed");
    expect(w.spawned).toHaveLength(1);
    // A new PLAN.md revision changes the manifest hash bound into the cache key: the scout reads again.
    await recordTaskFile(w.db, io, { taskId: "t1", kind: "plan", name: "PLAN.md", content: "plan v2 changed\n", producer });
    const third = await w.run({ plan: "the plan" });
    expect(third.state).toBe("passed");
    expect(w.spawned).toHaveLength(2);
  });

  it("a disabled pm-read pays no file IO even for a homed task", async () => {
    const w = pmReadWorld();
    saveProjectSetting(w.db, PROJECT, "pm_read.enabled", false);
    openTaskHome(w.db, { taskId: "t1", projectId: PROJECT, runId: "run", basePath: "/repo", hostId: "h" });
    const io = bbTaskFileIo(w.bb as never, "h", "/repo");
    await recordTaskFile(w.db, io, { taskId: "t1", kind: "plan", name: "PLAN.md", content: "plan v1\n", producer: { node: "dispatch" } });
    const result = await w.run({ plan: "the plan" });
    expect(result.state).toBe("skipped");
    expect(w.spawned).toHaveLength(0);
    expect(w.reads).toEqual([]); // no read_first count, no canonical plan read, no packet spill
  });

  it("pm-read falls back to the run's snapshot when no writer setting exists", async () => {
    const w = pmReadWorld();
    const result = await w.run();
    expect(result.state).toBe("passed");
    expect(w.spawned[0]).toMatchObject({ providerId: "codex", model: "model-a" });
  });
});

/** An accepted writer of the area "docs", whose thread runs model A. */
async function stickyWorld() {
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        get: async () => ({ status: "idle" }),
        defaultExecutionOptions: async () => ({ providerId: "codex", model: "model-a" }),
      },
    } as never,
  });
  const db = openDatabase(bb);
  const areaTask = { ...task, area: "docs" };
  createRun(db, "run", PROJECT, "cli", "/repo");
  createTask(db, { id: "t1", runId: "run", kind: "bb", contract: areaTask });
  createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
  db.prepare("UPDATE lane_pilot_attempt SET state='accepted', thread_id='writer-1', workspace_path='/wt/a1' WHERE id='a1'").run();
  const sticky = createWriterSticky({ bb, db, host: { call: async () => ({}) }, log: () => undefined } as never, {} as never);
  await sticky.noteAccepted(PROJECT, "run", areaTask, "a1", []);
  return { sticky };
}

describe("the sticky area writer", () => {
  it("is retired when the writer setting now names another model", async () => {
    const { sticky } = await stickyWorld();
    expect(await sticky.hotWriter(PROJECT, "run", "docs", { providerId: "codex", model: "model-b" })).toBeNull();
  });

  it("keeps taking the next task of its area while the writer setting still names its model", async () => {
    const { sticky } = await stickyWorld();
    expect(await sticky.hotWriter(PROJECT, "run", "docs", { providerId: "codex", model: "model-a" }))
      .toMatchObject({ threadId: "writer-1", attemptId: "a1" });
  });

  it("is kept when no writer setting is given, as before", async () => {
    const { sticky } = await stickyWorld();
    expect(await sticky.hotWriter(PROJECT, "run", "docs")).toMatchObject({ threadId: "writer-1" });
  });
});
