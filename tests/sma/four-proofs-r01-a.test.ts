// Region 1 (Task graph), batch a: the four proofs for ac_open .. ac_channel (the attempt's start: registration, reconcile, intent, permit,
// reserve, effects, recovery, budget questions, baseline). A test here checks the result the card names, never that a function was called.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createReconcile } from "../../src/rooms/stability/server/reconcile";
import { createWriterSpawn } from "../../src/rooms/writer/server/spawn";
import { writerPermit } from "../../src/rooms/writer/server/start-admission";
import { countAttempts, createAttempt, createRun, createTask, getAttempt, getRun, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { config, contract, open, seedAttempt } from "./r01-world-a";

describe("[sma:ac_open] registration of an attempt", () => {
  it("[sma:ac_open] an attempt is a row with its own id, state queued, the next attempt number and the build that made it; the run keeps its frozen ceilings", async () => {
    const { db, harness } = open();
    createRun(db, "run1", "projA", "bb", null, "none", { schemaVersion: 1, maxTurns: 17, pools: { provider: 3, verification: 2 } });
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: contract("t1") });
    createAttempt(db, { id: "att-1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "att-1", "spawn_requested");
    transitionAttempt(db, "att-1", "running");
    transitionAttempt(db, "att-1", "validation_failed", { reason: "verification failed (npm test): boom" });
    createAttempt(db, { id: "att-2", runId: "run1", taskId: "t1" });
    const first = getAttempt(db, "att-1")!;
    const second = getAttempt(db, "att-2")!;
    // The token is the id; the number grows with every attempt of the task; a fresh row waits in queued, stamped with the build.
    expect([first.id, first.attempt_no, second.id, second.attempt_no, second.state]).toEqual(["att-1", 1, "att-2", 2, "queued"]);
    expect(second.harness_version).toBeTruthy();
    expect(countAttempts(db, "run1", "t1")).toBe(2);
    // The ceilings are frozen on the run when it starts, not read from later settings.
    expect(JSON.parse(getRun(db, "run1")!.run_policy_json)).toEqual({ schemaVersion: 1, maxTurns: 17, pools: { provider: 3, verification: 2 } });
    await harness.lifecycle.dispose();
  });
});

describe("[sma:ac_reconcile] the last attempt's effects are checked against the world", () => {
  const triple = { lanePilotRunId: "run1", lanePilotTaskId: "t1", attemptId: "t1-a1" };
  /** An attempt whose spawn failed over the network (spawn_unknown); the world answers with the given threads. */
  function world(threads: Array<Record<string, unknown>>) {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    seedAttempt(db, "t1", [["spawn_requested"], ["spawn_unknown", "fetch failed"]]);
    const live = { ...bb, sdk: { threads: {
      list: async () => threads.map((_, index) => ({ id: `thr_${index}` })),
      getPluginMetadata: async ({ threadId }: { threadId: string }) => threads[Number(threadId.slice(4))] ?? {},
    } } };
    const reconcile = createReconcile({ acceptedTaskWorkspace: async () => null, bb: live, configForRun: async () => config, db, refreshRun: () => undefined } as never, {} as never);
    return { db, harness, run: () => reconcile.reconcileAttemptThread("projA", getAttempt(db, "t1-a1")!) };
  }

  it("[sma:ac_reconcile] a thread the world holds for the attempt is adopted: the attempt runs on it", async () => {
    const w = world([{ ...triple, role: "writer" }, { ...triple, attemptId: "other-attempt" }]);
    await expect(w.run()).resolves.toBe("thr_0");
    expect(getAttempt(w.db, "t1-a1")).toMatchObject({ state: "running", thread_id: "thr_0" });
    await w.harness.lifecycle.dispose();
  });

  it("[sma:ac_reconcile] no thread after a complete scan ends the attempt as rejected and keeps the spawn error; two threads block it", async () => {
    const none = world([{ ...triple, attemptId: "other-attempt" }]);
    await expect(none.run()).rejects.toThrow("writer spawn was not created after a complete reconcile scan");
    expect(getAttempt(none.db, "t1-a1")).toMatchObject({ state: "spawn_rejected", reason: "spawn failed: fetch failed; reconcile completed on a short page without a matching thread" });
    await none.harness.lifecycle.dispose();
    const twice = world([{ ...triple }, { ...triple }]);
    await expect(twice.run()).rejects.toThrow("writer reconcile blocked: ambiguous");
    expect(getAttempt(twice.db, "t1-a1")).toMatchObject({ state: "blocked", reason: "reconcile_ambiguous" });
    await twice.harness.lifecycle.dispose();
  });
});

describe("[sma:ac_intent] the launch intent is on the row before the process", () => {
  it("[sma:ac_intent] the attempt reads spawn_requested while the spawn call is in flight; a spawn that dies unseen leaves spawn_unknown with its error for the reconcile", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "P", "cli", "/repo");
    setRunThread(db, "run1", "pm");
    seedAttempt(db, "t1");
    const seen: Array<[string, string, string | null]> = [];
    const ctx = {
      bb: { storage: bb.storage, log: { info() {}, warn() {} }, sdk: {
        projects: { get: async () => ({ sources: [] }) },
        providers: { list: async () => [{ id: "codex", available: true, serviceTiers: [{ id: "default" }] }], models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }) },
        files: { read: async () => ({ content: null }) },
        threads: { get: async () => ({ id: "pm", projectId: "P", status: "idle" }), stop: async () => ({}),
          spawn: async () => { const row = getAttempt(db, "t1-a1")!; seen.push(["at spawn", row.state, row.reason]); throw new Error("fetch failed"); } } } },
      db,
      host: { call: async (method: string) => method === "runCommand" ? { hostId: "h", exitCode: 0, stdout: "[]", stderr: "" } : method === "gitCreateWorktree" ? { status: "ready", path: "/wt/a1/repo", branch: "lane/a1", reason: null } : {} },
      effectiveProjectSettings: async () => ({ values: { "memory.enabled": false, "adoc.040": "auto" } }),
    };
    const services = {
      providerBreaker: { decide: () => ({ allow: true }), releaseTrial: () => undefined }, ruleScan: { chainForRun: async () => [] },
      reconcileAttemptThread: async () => { const row = getAttempt(db, "t1-a1")!; seen.push(["at reconcile", row.state, row.reason]); return "thr_found"; },
    };
    const writer = createWriterSpawn(ctx as never, services as never);
    await expect(writer.spawnWriterAttempt({ projectId: "P", runId: "run1", taskId: "t1", attemptId: "t1-a1", config, task: contract("t1"), plan: "write", pmThreadId: "pm" }))
      .resolves.toMatchObject({ ok: true, threadId: "thr_found" });
    expect(seen).toEqual([["at spawn", "spawn_requested", null], ["at reconcile", "spawn_unknown", "fetch failed"]]);
    await harness.lifecycle.dispose();
  });
});

describe("[sma:ac_permit] the permit before the writer's turn", () => {
  const open2 = () => {
    const { db, harness } = open();
    createRun(db, "run1", "projA");
    for (const [id, appetite] of [["t1", 50], ["t2", 200], ["t3", undefined]] as const) createTask(db, { id, runId: "run1", kind: "bb", contract: contract(id, appetite ? { appetite: { tokens: appetite } } as never : {}) });
    return { db, harness };
  };
  const state = (maxTokens: number | null, tokens: number) => ({ budget: { snapshot: () => ({ limits: { maxTokens }, tokens }) } }) as never;
  const input = (taskId: string, appetite?: number) => ({ runId: "run1", taskId, task: { appetite: appetite ? { tokens: appetite } : undefined } }) as never;

  it("[sma:ac_permit] a task with a price and room passes; a task without a price, or past the reserve the run's other open tasks left, is refused with its reason", async () => {
    const { db, harness } = open2();
    const deps = { ctx: { db } } as never;
    // Another task of the run holds 200 tokens of the 1000 (its attempt is open); this task's own open attempt reserves nothing against itself.
    createAttempt(db, { id: "t2-a1", runId: "run1", taskId: "t2" });
    createAttempt(db, { id: "t1-a1", runId: "run1", taskId: "t1" });
    // No run.max_tokens: nothing to hold, even a task without a price passes.
    expect(writerPermit(deps, state(null, 999), input("t3"), )).toBeNull();
    expect(writerPermit(deps, state(1000, 100), input("t1", 50))).toBeNull();
    expect(writerPermit(deps, state(1000, 100), input("t3"))).toBe("permit_refused:price_unknown: the run has run.max_tokens but task t3 names no appetite.tokens");
    // 1000 - 100 spent - 200 reserved by t2 = 700 free: 700 fits, 701 does not.
    expect(writerPermit(deps, state(1000, 100), input("t1", 700))).toBeNull();
    expect(writerPermit(deps, state(1000, 100), input("t1", 701))).toBe("permit_refused:reserve: the run's budget keeps 700 tokens after the open tasks' appetites; this task's appetite is 701");
    await harness.lifecycle.dispose();
  });
});
