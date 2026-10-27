import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../../src/rooms/storage/database";
import { createWriterStart } from "../../src/rooms/writer/server/start";

// A blocked wave pilot holds its siblings only while a redo is coming; once its attempts are spent or the wall holds its family they go on.
const WORKSPACE = "/ws";
const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
const contract = (id: string, dependsOn: string[] = []): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: ["a.txt"], owns_paths: ["scripts/gamedata/"], never_touch: [], depends_on: dependsOn,
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }],
});

function world(options: { pilotAttempts: number; wall?: boolean; dependsOn?: string[] }) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  harness.sdk.stub("threads.send", async () => undefined);
  harness.sdk.stub("threads.context", async () => ({ usage: null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  // The wave: P0 is the pilot (earliest), T1 and T2 share its folder.
  for (const id of ["P0", "T1", "T2"]) { createTask(db, { id, runId: "run1", kind: "bb", contract: contract(id, id === "T1" ? options.dependsOn ?? [] : []) }); saveTaskPlan(db, id, `Plan for ${id}`); }
  for (let n = 1; n <= options.pilotAttempts; n++) {
    createAttempt(db, { id: `P0-a${n}`, runId: "run1", taskId: "P0" });
    db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason='validation_failed: boom' WHERE id=?").run(`P0-a${n}`);
  }
  if (options.wall) db.prepare(`INSERT INTO lane_pilot_wall(wall_key,kind,subject,project_id,state,pack_json,created_at,updated_at) VALUES ('task:x','task','P0: boom','proj1','stopped',?,1,1)`)
    .run(JSON.stringify({ meta: { runId: "run1", family: "P0" } }));
  const spawned: string[] = [];
  const svc = {
    activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
    runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
    runWriterPool: { acquire: async () => () => undefined },
    stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
    startAfterAcceptance: () => undefined,
    workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
    spawnWriterAttempt: async (input: { attemptId: string }) => {
      spawned.push(input.attemptId);
      setAttemptWorkspace(db, input.attemptId, { path: "/ws/wt", environmentId: null, decision: {} });
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "running", { threadId: "thr_w" });
      return { ok: true, threadId: "thr_w", providerId: "p", model: "wm", dirtBefore: [], workspacePath: "/ws/wt" };
    },
    finishWriterAttempt: async (input: { attemptId: string }) => { transitionAttempt(db, input.attemptId, "accepted"); return { status: "accepted", produced: ["a.txt"], verification: [] }; },
  } as unknown as Services;
  Object.assign(svc, createWriterStart(ctx, svc));
  const startT1 = () => {
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run1", taskId: "T1", stageId, state: "pending", input: "Plan for T1" });
    createAttempt(db, { id: "T1-a1", runId: "run1", taskId: "T1" });
    svc.startWriterTask({ projectId: "proj1", runId: "run1", taskId: "T1", firstAttemptId: "T1-a1", pmThreadId: "thr_pm", config, task: contract("T1", options.dependsOn ?? []), plan: "Plan for T1" });
  };
  const reason = () => listStageReceipts(db, "run1", "T1").find((row) => row.stageId === "writer-agent")?.reason ?? "";
  return { startT1, spawned, reason };
}

it("a sibling goes on at once when its blocked pilot spent its attempts", async () => {
  const w = world({ pilotAttempts: 2 });
  w.startT1();
  await vi.waitFor(() => expect(w.spawned).toEqual(["T1-a1"]));
});

it("a sibling goes on at once when the wall ladder holds its blocked pilot's family", async () => {
  const w = world({ pilotAttempts: 1, wall: true });
  w.startT1();
  await vi.waitFor(() => expect(w.spawned).toEqual(["T1-a1"]));
});

it("a sibling keeps waiting for a blocked pilot that may still be sent again", async () => {
  const w = world({ pilotAttempts: 1 });
  w.startT1();
  await vi.waitFor(() => expect(w.reason()).toContain("waiting for depends_on: P0"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(w.spawned).toEqual([]);
});

it("the PM's own depends_on keeps its 6-hour wait even when the pilot's attempts are spent", async () => {
  const w = world({ pilotAttempts: 2, dependsOn: ["P0"] });
  w.startT1();
  await vi.waitFor(() => expect(w.reason()).toContain("waiting for depends_on: P0"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(w.spawned).toEqual([]);
});
