import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LP_DEFAULTS_KEY } from "@lane-pilot/settings-catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { runPmRead } from "../src/rooms/critique/server/critique-runs";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, setRunThread } from "../src/rooms/storage/database";
import { createWriterSticky } from "../src/rooms/writer/server/sticky";

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
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      files: { read: async () => ({ content: notes, contentEncoding: "utf8", sha256: "f".repeat(64), sizeBytes: notes.length }) },
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
  const run = () => runPmRead({ bb, db, projectId: PROJECT, runId: "run", taskId: "t1", pmThreadId: "pm-thread", config, task });
  return { bb, db, spawned, run };
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
