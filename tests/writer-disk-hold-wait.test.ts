import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { noOptionalPlugins } from "./optional-plugin-stubs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { createWriterStart } from "../src/rooms/writer/server/start";
import { createStability } from "../src/rooms/stability/server/stability";
import { failureClass } from "../src/rooms/runs/failure-class";
import { logOrigin } from "../src/rooms/wall/signature";

// log:4b8289a2c542 and its siblings (hub plugin.log, 2026-10-27): the Mac mini had 5–11 GB free, below the 15 GB disk hold, and
// «writer drill-20261027-023238-b waits: only N GB free on host_7sea4qaad8» was logged 61 times, once for every GB the free space
// moved; the drill's canceled writers (…-memory, drill-pm-20261027-note) kept waiting and logging for half an hour after their
// cancel; and the line read as Lane Pilot's own failure («harness»), so the night sent repair rounds for a full disk.
const HOST = "host_7sea4qaad8";
const WORKSPACE = "/ws";
const config: PrototypeConfig = { projectId: "proj1", hostId: HOST, pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
const taskOf = (id: string): TaskV2 => ({
  schema_version: 2, id, title: `Drill note ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`notes/drill/${id}.md`], owns_paths: [`notes/drill/${id}.md`], never_touch: [], depends_on: [],
  objective: "Write the drill note", acceptance: ["done"], verify: "tests", verification: [{ command: `test -f notes/drill/${id}.md`, cwd: WORKSPACE }],
});
// The free space the hub log shows for drill-20261027-023238-b, poll by poll (GB).
const READINGS = [9, 8, 7, 5, 7, 9, 10, 9, 8, 7];
const GiB = 2 ** 30;

let scale: string | undefined;
beforeEach(() => { scale = process.env.LANE_PILOT_POLL_SCALE; process.env.LANE_PILOT_POLL_SCALE = "0.0005"; });
afterEach(() => { process.env.LANE_PILOT_POLL_SCALE = scale; });

function setup(task: TaskV2, diskHolds: () => Promise<string | null>) {
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
  const lines: string[] = [];
  const log = ctx.log.bind(ctx);
  ctx.log = (message: string, ...rest: unknown[]) => { lines.push(message); return (log as (...args: unknown[]) => void)(message, ...rest); };
  const spawned: string[] = [];
  const svc = {
    activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
    runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
    runWriterPool: { acquire: async () => () => undefined },
    stability: { breakerHolds: () => null, onTaskFailed: async () => false, loadParked: async () => [], diskHolds },
    maintainMemoryAfterAcceptance: () => undefined, maintainProjectLifeAfterAcceptance: () => undefined,
    workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
    spawnWriterAttempt: async (input: { attemptId: string }) => {
      spawned.push(input.attemptId);
      setAttemptWorkspace(db, input.attemptId, { path: "/ws/wt", environmentId: null, decision: {} });
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "running", { threadId: "thr_w" });
      return { ok: true, threadId: "thr_w", providerId: "p", model: "wm", dirtBefore: [], workspacePath: "/ws/wt" };
    },
    finishWriterAttempt: async (input: { attemptId: string }) => {
      transitionAttempt(db, input.attemptId, "accepted");
      return { status: "accepted", produced: task.expected_outputs, verification: [] };
    },
  } as unknown as Services;
  createTask(db, { id: task.id, runId: "run1", kind: "bb", contract: task });
  saveTaskPlan(db, task.id, "Plan");
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run1", taskId: task.id, stageId, state: "pending", input: "Plan" });
  createAttempt(db, { id: "a1", runId: "run1", taskId: task.id });
  Object.assign(svc, createWriterStart(ctx, svc));
  svc.startWriterTask({ projectId: "proj1", runId: "run1", taskId: task.id, firstAttemptId: "a1", pmThreadId: "thr_pm", config, task, plan: "Plan" });
  return { db, lines, spawned, harness };
}

describe("a writer held by a low disk (Mac mini, 2026-10-27)", () => {
  it("logs its wait once while the free space moves, keeps the stage reason current, and starts once there is room", async () => {
    const task = taskOf("drill-20261027-023238-b");
    let poll = 0;
    const reasons: string[] = [];
    let db!: ReturnType<typeof setup>["db"];
    const run = setup(task, async () => {
      const free = READINGS[poll++];
      const stage = listStageReceipts(db, "run1", task.id).find((row) => row.stageId === "writer-agent");
      if (stage?.reason) reasons.push(stage.reason);
      return free === undefined ? null : `disk_low: only ${free} GB free on ${HOST}`;
    });
    db = run.db;
    await vi.waitFor(() => expect(run.spawned).toEqual(["a1"]), { timeout: 10_000 });
    expect(poll).toBe(READINGS.length + 1);
    expect(run.lines.filter((line) => line.includes("waits:"))).toEqual([`writer ${task.id} waits: disk_low: only 9 GB free on ${HOST}`]);
    expect(reasons.at(-1)).toBe(`waiting: disk_low: only 7 GB free on ${HOST}; starts by itself once it clears`);
    await run.harness.lifecycle.dispose();
  });

  it("stops waiting when its attempt is canceled, closes its writer stage and starts no writer", async () => {
    const task = taskOf("drill-20261027-023238-memory");
    let poll = 0;
    let db!: ReturnType<typeof setup>["db"];
    const run = setup(task, async () => {
      poll += 1;
      // The drill cancels the waiting attempt (bb lane-pilot cancel) after the third poll; the disk stays full.
      if (poll === 3) transitionAttempt(db, "a1", "canceled", { reason: "drill quiet" });
      return `disk_low: only ${READINGS[poll % READINGS.length]} GB free on ${HOST}`;
    });
    db = run.db;
    await vi.waitFor(() => expect(listStageReceipts(db, "run1", task.id).find((row) => row.stageId === "writer-agent")?.state).toBe("canceled"), { timeout: 10_000 });
    const polled = poll;
    await new Promise((wake) => setTimeout(wake, 200));
    expect(poll).toBe(polled);
    expect(polled).toBeLessThanOrEqual(4);
    expect(run.spawned).toEqual([]);
    expect(getAttempt(db, "a1")?.state).toBe("canceled");
    expect(run.lines.filter((line) => line.includes("waits:"))).toHaveLength(1);
    await run.harness.lifecycle.dispose();
  });
});

describe("the disk hold's reason is the machine's", () => {
  async function holdAt(freeGb: number, totalGb: number) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const host = { call: async () => ({ freeBytes: freeGb * GiB, totalBytes: totalGb * GiB }) };
    const { stability } = createStability({ bb, isDisposed: () => false, db: openDatabase(bb), host, log: () => undefined } as never, { activeWriterTasks: new Set() } as never);
    return stability.diskHolds(HOST, "/ws");
  }

  it("carries disk_low, so the failure classes, the night journal and the metrics read it as infra", async () => {
    const reason = await holdAt(9, 460);
    expect(reason).toBe(`disk_low: only 9 GB free on ${HOST}`);
    expect(logOrigin(`writer drill-20261027-023238-b waits: ${reason}`)).toBe("infra");
    expect(failureClass("blocked", `waiting: ${reason}; starts by itself once it clears`)).toBe("infra");
    expect(await holdAt(20, 460)).toBeNull();
  });
});
