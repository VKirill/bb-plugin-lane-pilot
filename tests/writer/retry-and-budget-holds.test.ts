// Shared helpers of the region 1 batch a four-proofs tests (tests/sma/four-proofs-r01-a*.test.ts). Batch b has its own world file.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { recordStage } from "../../src/rooms/runs/server";
import { createWriterStart } from "../../src/rooms/writer/server/services/start";
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

/** What a node's behaviour test saw, for the region scene (scenes/sma_r01_a.py): written as <dir>/<node>.json when SMA_R01A_OBSERVED names a folder, else nothing. */
export function observe(node: string, value: unknown): void {
  const dir = process.env.SMA_R01A_OBSERVED;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${node}.json`), JSON.stringify(value));
}


// Region 1 (Task graph), batch a: the four proofs for the budget questions and the failure path (ac_budget_q, ac_pocket, ae_fail, ae_awaits,
// ae_exhausted, ae_parked, ag_parked). Results are read off the attempt rows, the owner items and the messages to the PM.
import { describe, expect, it, vi } from "vitest";
import { watchWriterRun } from "../../src/rooms/writer/server/services/watch-writer";
import { listOpenOwnerItemKeys } from "../../src/rooms/owner-waiting";

describe("[sma:ac_budget_q] the stage budget question", () => {
  it("[sma:ac_budget_q] at four fifths of the task's appetite minutes the PM is asked once whether to extend them; before that nothing is said", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const sends: Array<{ threadId: string; input: Array<{ text: string }> }> = [];
      let status = "active";
      const ctx = {
        bb: { sdk: { threads: { send: async (args: never) => { sends.push(args); }, stop: async () => undefined, events: { list: async () => [] }, list: async () => [], get: async () => ({ status }) } }, storage: { kv: { get: async () => null, set: async () => undefined } }, log: { warn() {}, info() {} } },
        db: open().db, state: { disposed: false }, log: () => undefined, getThreadBounded: async () => ({ status }),
      };
      const budget = { snapshot: () => ({ limits: {} }), check: () => ({ ok: true }), noteTokens: () => undefined };
      const run = watchWriterRun({ ctx: ctx as never, services: { runBudgetFor: () => budget } as never, facts: {}, providerFailed: () => null, holdProviderLimit: () => undefined,
        input: { projectId: "projA", runId: "run1", taskId: "t1", attemptId: "t1-a1", writerThreadId: "thr_w", pmThreadId: "thr_pm", task: { appetite: { minutes: 10 } } } as never });
      await vi.advanceTimersByTimeAsync(7 * 60_000);
      const askedBefore = sends.length;
      expect(sends).toEqual([]);
      await vi.advanceTimersByTimeAsync(1.5 * 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sends).toHaveLength(1);
      observe("n165", { askedAt7min: askedBefore, askedAt9min: sends.length, to: sends[0]!.threadId, text: sends[0]!.input[0]!.text });
      expect(sends[0]!.threadId).toBe("thr_pm");
      expect(sends[0]!.input[0]!.text).toContain("Task t1 has spent 80% of its appetite (8/10 min)");
      expect(sends[0]!.input[0]!.text).toContain("lane_pilot_update_task");
      status = "idle";
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(run).resolves.toBeNull();
      expect(sends).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("[sma:ac_pocket] the run's remainder ran out", () => {
  it("[sma:ac_pocket] when the run's token budget runs out between two attempts the next one is not started: it is blocked with the budget reason and one question goes to the owner with raise and finish actions", async () => {
    let spent = false;
    const budget = { check: () => spent ? { ok: false, exceeded: "maxTokens", used: 11, limit: 10, reason: "run budget exceeded" } : { ok: true }, noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) };
    const w = startWorld({ budget, onFinish: () => { spent = true; }, finishes: [{ status: "validation_failed", reason: "verification failed (npm test): boom" }] });
    w.start();
    await vi.waitFor(() => expect(listOpenOwnerItemKeys(w.db, { kind: "budget_spent" })).toEqual(["run-budget:run1"]), { timeout: 10_000 });
    expect(w.spawned).toEqual(["T1-a1"]);
    const rows = w.attempts();
    expect(rows.at(-1)).toMatchObject({ state: "blocked", reason: "run_budget_exceeded:tokens" });
    const item = w.db.prepare("SELECT what, actions_json FROM lane_pilot_owner_item WHERE key='run-budget:run1'").get() as { what: string; actions_json: string };
    observe("n166", { spawned: w.spawned, lastState: rows.at(-1)!.state, lastReason: rows.at(-1)!.reason, what: item.what, actions: JSON.parse(item.actions_json).map((action: { id: string }) => action.id) });
    expect(item.what).toBe("Лимит прогона исчерпан: токены, потрачено 11 при лимите 10");
    expect(JSON.parse(item.actions_json).map((action: { id: string }) => action.id)).toEqual(["raise", "finish"]);
    await w.harness.lifecycle.dispose();
  });
});

describe("[sma:ae_fail] an attempt's failure is on its row", () => {
  it("[sma:ae_fail] a failed attempt keeps its reason and the structured failure code; an accepted attempt is not overwritten by a later failure", async () => {
    const { db, harness } = open();
    seedAttempt(db, "t1", [["spawn_requested"], ["running", ""]]);
    transitionAttempt(db, "t1-a1", "validation_failed", { reason: "verification failed (npm test): boom", failureCode: "verification_red" as never, checkName: "npm test" });
    expect(db.prepare("SELECT state, reason, failure_code, check_name FROM lane_pilot_attempt WHERE id='t1-a1'").get())
      .toEqual({ state: "validation_failed", reason: "verification failed (npm test): boom", failure_code: "verification_red", check_name: "npm test" });
    seedAttempt(db, "t2", [["spawn_requested"], ["running"], ["accepted"]]);
    // The row is settled: a failure written later is refused, the journal shows the refusal, the state stays accepted.
    expect(transitionAttempt(db, "t2-a1", "validation_failed", { reason: "late failure" })).toBe(false);
    expect(db.prepare("SELECT state, reason FROM lane_pilot_attempt WHERE id='t2-a1'").get()).toEqual({ state: "accepted", reason: null });
    expect(db.prepare("SELECT refused FROM lane_pilot_attempt_transition WHERE attempt_id='t2-a1' AND to_state='validation_failed'").get()).toEqual({ refused: 1 });
    await harness.lifecycle.dispose();
  });
});

describe("[sma:ae_exhausted] the queue's word «I will not re-issue again»", () => {
  it("[sma:ae_exhausted] a task whose three attempts all failed is blocked with «retry limit 3 exhausted» and its last reason, and no fourth writer starts", async () => {
    const w = startWorld({ finishes: [{ status: "validation_failed", reason: "owns_paths: src/x.ts is outside the contract" }] });
    // The task's first two writer sessions (other threads) already failed: this is its third attempt.
    w.start("T1", {}, (db) => {
      for (const n of [1, 2]) {
        const id = `T1-p${n}`;
        createAttempt(db, { id, runId: "run1", taskId: "T1" });
        transitionAttempt(db, id, "spawn_requested");
        transitionAttempt(db, id, "running", { threadId: `thr_old_${n}` });
        transitionAttempt(db, id, "validation_failed", { reason: `verification failed (npm test): fault ${n}` });
      }
    });
    await vi.waitFor(() => expect(w.attempts().at(-1)?.state).toBe("blocked"), { timeout: 20_000 }).catch((cause) => { console.log(JSON.stringify(w.attempts()), w.spawned); throw cause; });
    const rows = w.attempts();
    expect(rows.map((row) => [row.attempt_no, row.state])).toEqual([[1, "validation_failed"], [2, "validation_failed"], [3, "blocked"]]);
    expect(rows[2]!.reason).toBe("retry limit 3 exhausted: owns_paths: src/x.ts is outside the contract");
    expect(w.spawned).toEqual(["T1-a1"]);
    await w.harness.lifecycle.dispose();
  });
});

describe("[sma:ae_parked] a failure that is not the task's waits for a person", () => {
  it("[sma:ae_parked] a dirty base checkout parks the task at once: one attempt, blocked with the reason, no retry is spent on it", async () => {
    const reason = "merge failed: your local changes would be overwritten by merge in src/a.ts";
    const w = startWorld({ finishes: [{ status: "validation_failed", reason }, { status: "accepted" }] });
    w.start();
    await vi.waitFor(() => expect(w.attempts().at(-1)?.state).toBe("blocked"), { timeout: 20_000 });
    observe("n178", { attempts: w.attempts().map((row) => [row.attempt_no, row.state, row.reason]), spawned: w.spawned, reason });
    expect(w.attempts().map((row) => [row.attempt_no, row.state, row.reason])).toEqual([[1, "blocked", reason]]);
    expect(w.spawned).toEqual(["T1-a1"]);
    await w.harness.lifecycle.dispose();
  });
});

