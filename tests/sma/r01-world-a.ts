// Shared helpers of the region 1 batch a four-proofs tests (tests/sma/four-proofs-r01-a*.test.ts). Batch b has its own world file.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/plugin-db";

export const config: PrototypeConfig = {
  projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo",
  pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test",
};

export const contract = (id: string, patch: Partial<TaskV2> = {}): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [], depends_on: [],
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [], ...patch,
});

/** A plugin database on a fake host; the harness is disposed by the caller. */
export function open() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { bb, harness, db: openDatabase(bb) };
}

/** A run `run1` of `projA`, a task and an attempt moved through the given states (each with an optional reason). */
export function seedAttempt(db: ReturnType<typeof openDatabase>, taskId: string, steps: Array<[string] | [string, string]> = [], attemptId = `${taskId}-a1`) {
  if (!db.prepare("SELECT 1 FROM lane_pilot_run WHERE id='run1'").get()) createRun(db, "run1", "projA");
  if (!db.prepare("SELECT 1 FROM lane_pilot_task WHERE id=?").get(taskId)) createTask(db, { id: taskId, runId: "run1", kind: "bb", contract: contract(taskId) });
  createAttempt(db, { id: attemptId, runId: "run1", taskId });
  for (const [state, reason] of steps) transitionAttempt(db, attemptId, state as never, reason ? { reason } : {});
  return attemptId;
}

// ---- the writer start flow with a fake spawn and a fake finish (what tests/baseline/start.test.ts builds, with a finish that can fail) ----
import { noOptionalPlugins } from "../optional-plugin-stubs";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { createWriterStart } from "../../src/rooms/writer/server/start";
import { getAttempt, listStageReceipts, saveProjectSetting, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread } from "../../src/rooms/plugin-db";

const WS = "/ws";
const startConfig: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WS, writerWorkspacePath: WS, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };

/** One finish of a fake writer: the state the attempt ends in and its reason ("accepted" ends the task). */
export type FakeFinish = { status: "accepted" | "validation_failed" | "blocked"; reason?: string };

/**
 * A task started through the real writer start loop (admission, budget, baseline, retries, failure route) with a fake spawn and a fake
 * finish: every attempt `finishes[n]` ends as told. `extra` replaces entries of the services bag; the budget is `budget` (default: unlimited).
 */
export function startWorld(options: { finishes?: FakeFinish[]; budget?: Record<string, unknown>; preflight?: (input: unknown) => Promise<unknown>; extra?: Record<string, unknown>; settings?: Record<string, unknown>; onFinish?: () => void } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  const sends: Array<{ threadId: string; input: Array<{ text: string }> }> = [];
  harness.sdk.stub("threads.send", async (args: unknown) => { sends.push(args as never); return undefined; });
  harness.sdk.stub("threads.context", async () => ({ usage: null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WS);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, startConfig);
  for (const [key, value] of Object.entries(options.settings ?? {})) saveProjectSetting(db, "proj1", key, value);
  const spawned: string[] = [];
  const finishes = [...(options.finishes ?? [{ status: "accepted" } as FakeFinish])];
  const services = {
    activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined, decide: () => ({ allow: true }) }, ...noOptionalPlugins,
    runBudgetFor: () => options.budget ?? { check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) },
    runWriterPool: { acquire: async () => () => undefined },
    stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
    startAfterAcceptance: () => undefined, workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
    ...(options.preflight ? { baseline: { preflight: options.preflight } } : {}), ...(options.extra ?? {}),
    spawnWriterAttempt: async (input: { attemptId: string }) => {
      spawned.push(input.attemptId);
      setAttemptWorkspace(db, input.attemptId, { path: `${WS}/wt/${input.attemptId}`, environmentId: null, decision: {} });
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "running", { threadId: "thr_w" });
      return { ok: true, threadId: "thr_w", providerId: "p", model: "wm", dirtBefore: [], workspacePath: `${WS}/wt/${input.attemptId}` };
    },
    finishWriterAttempt: async (input: { attemptId: string }) => {
      const next = finishes.shift() ?? { status: "accepted" as const };
      options.onFinish?.();
      transitionAttempt(db, input.attemptId, next.status, next.reason ? { reason: next.reason } : {});
      return { status: next.status, ...(next.reason ? { reason: next.reason } : {}), produced: [], verification: [] };
    },
  } as unknown as Services;
  const start = (taskId = "T1", patch: Partial<TaskV2> = {}, before?: (db: ReturnType<typeof openDatabase>) => void) => {
    const task = contract(taskId, { project_cwd: WS, owns_paths: [`${taskId}/**`, "a.txt"], expected_outputs: ["a.txt"], ...patch });
    createTask(db, { id: taskId, runId: "run1", kind: "bb", contract: task });
    saveTaskPlan(db, taskId, `Plan for ${taskId}`);
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run1", taskId, stageId, state: "pending", input: `Plan for ${taskId}` });
    before?.(db);
    createAttempt(db, { id: `${taskId}-a1`, runId: "run1", taskId });
    Object.assign(services, createWriterStart(ctx, services));
    services.startWriterTask({ projectId: "proj1", runId: "run1", taskId, firstAttemptId: `${taskId}-a1`, pmThreadId: "thr_pm", config: startConfig, task, plan: `Plan for ${taskId}` });
  };
  const attempts = (taskId = "T1") => db.prepare("SELECT id,state,reason,attempt_no FROM lane_pilot_attempt WHERE task_id=? ORDER BY attempt_no").all(taskId) as Array<{ id: string; state: string; reason: string | null; attempt_no: number }>;
  const writerStage = (taskId = "T1") => listStageReceipts(db, "run1", taskId).find((row) => row.stageId === "writer-agent");
  return { bb, harness, db, ctx, sends, spawned, start, attempts, writerStage, state: (id = "T1-a1") => getAttempt(db, id)?.state };
}
