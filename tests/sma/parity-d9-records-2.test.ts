import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { buildTaskBoard } from "../../src/rooms/runs/server/task-board";
import { workFilePathError, workFileRead } from "../../src/rooms/runs/server/work-file";
import { seedConveyor, conveyorState } from "../../src/rooms/runs/conveyor";
import { phaseBoardCards } from "../../src/rooms/phase";
import { insertPhase, savePhase } from "../../src/rooms/phase/store";
import { STATE_MACHINE_VERSION } from "../../src/rooms/contracts/state-machine";
import {
  attemptTransitionsForTask, createAttempt, createRun, createTask, getReasoningTrace, inspectAttempt, listRunTransitions, openDatabase,
  saveReasoningTrace, setTaskHeldUntil, transitionAttempt, workerOutcomesSince, workerPresenceNow,
} from "../../src/rooms/plugin-db";
import type { PhaseRecord } from "../../src/rooms/phase/logic";

function db0() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { bb, db: openDatabase(bb) };
}

const piece = (id: string, wave: number) => ({ id, title: id, wave, promise: { given: "g", when: "w", then: "t" }, task: { id, owns_paths: [`${id}/**`] } });
const PLAN: PhaseRecord = { plan: { items: [piece("a", 1), piece("b", 2)] } };

describe("m_sw_unit_card + d_state: phase cards and held on the board", () => {
  it("a phase is one card with stage column, next action, gates and wave; a task carries held", () => {
    const { db } = db0();
    createRun(db, "run_p", "proj_p", "bb", "/w");
    createTask(db, { id: "t1", runId: "run_p", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run_p", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested", { reason: "work" });
    transitionAttempt(db, "a1", "running", { reason: "work" });
    insertPhase(db, { id: "ph1", projectId: "proj_p", pmThreadId: "thr", title: "Phase one", goal: "goal", runId: "run_p", at: Date.now() });
    savePhase(db, "ph1", { stage: "execution", record: PLAN, at: Date.now() });
    const doneSince = Date.now() - 86_400_000;
    const phases = phaseBoardCards(db, { projectId: "proj_p", doneSince });
    const items = buildTaskBoard(db, { projectId: "proj_p", doneSince }, phases as never);
    const card = items.find((item) => item.kind === "phase");
    expect(card).toMatchObject({ kind: "phase", column: "running", title: "Phase one", wave: { n: 1, m: 2 } });
    expect(card!.gates).toHaveLength(3);
    expect(card!.gates!.map((gate) => gate.name)).toEqual(["discussion", "plan", "design"]);
    const task = items.find((item) => item.kind === "task");
    expect(task).toMatchObject({ held: false, gates: null });
    setTaskHeldUntil(db, "t1", "run_p", Date.now() + 60_000);
    const held = buildTaskBoard(db, { projectId: "proj_p", doneSince }, []).find((item) => item.kind === "task");
    expect(held!.held).toBe(true);
    setTaskHeldUntil(db, "t1", "run_p", Date.now() - 1000);
    const free = buildTaskBoard(db, { projectId: "proj_p", doneSince }, []).find((item) => item.kind === "task");
    expect(free!.held).toBe(false);
  });

  it("a paused phase is blocked; a closed one is done", () => {
    const { db } = db0();
    insertPhase(db, { id: "ph2", projectId: "proj_p", pmThreadId: "thr", title: "Stopped", goal: "g", at: 1 });
    savePhase(db, "ph2", { state: "paused", at: 2 });
    const cards = phaseBoardCards(db, { projectId: "proj_p", doneSince: 0 });
    expect(cards.find((card) => card.key === "phase:ph2")?.column).toBe("blocked");
  });
});

describe("ar_ledger: attempt transitions are append-only", () => {
  it("update and delete on the journal and delete on the attempt are refused", () => {
    const { db } = db0();
    createRun(db, "run_l", "proj_l");
    createTask(db, { id: "tl", runId: "run_l", kind: "bb", contract: {} });
    createAttempt(db, { id: "al", runId: "run_l", taskId: "tl" });
    transitionAttempt(db, "al", "spawn_requested", { reason: "go" });
    transitionAttempt(db, "al", "running", { reason: "go" });
    expect(() => db.prepare("UPDATE lane_pilot_attempt_transition SET reason='x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM lane_pilot_attempt_transition").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM lane_pilot_attempt").run()).toThrow(/append-only/);
    const rows = listRunTransitions(db, "run_l");
    expect(rows.some((row) => row.to_state === "running")).toBe(true);
  });
});

describe("m_cfg_pipeline_off: factory conveyor seed", () => {
  const kv = () => { const map = new Map<string, unknown>(); return { get: async (k: string) => map.get(k), set: async (k: string, v: unknown) => { map.set(k, v); } }; };
  it("a hub with no runs is seeded off once; a hub with runs is never touched", async () => {
    const { db } = db0();
    const store = kv();
    await seedConveyor(store, db);
    const state = await conveyorState(store);
    expect(state.on).toBe(false);
    expect(state.reason).toMatch(/factory default/);
    await seedConveyor(store, db); // the marker means once
    const { db: db2 } = db0();
    createRun(db2, "run_x", "proj_x");
    const store2 = kv();
    await seedConveyor(store2, db2);
    expect((await conveyorState(store2)).on).toBe(true);
    // An explicit owner switch is never overwritten by a later seed on an empty hub.
    const { db: db3 } = db0();
    const store3 = kv();
    await store3.set("conveyor:off", { at: Date.now(), reason: "owner" });
    await seedConveyor(store3, db3);
    expect((await conveyorState(store3)).reason).toBe("owner");
  });
});

describe("d_artifact: bounded work file read", () => {
  it("refuses escape and secret paths, reads a bounded window", async () => {
    expect(workFilePathError("../x")).toMatch(/refused/);
    expect(workFilePathError("/etc/passwd")).toMatch(/refused/);
    expect(workFilePathError(".git/config")).toMatch(/refused/);
    expect(workFilePathError("a/.env")).toMatch(/refused/);
    expect(workFilePathError("src/app.ts")).toBeNull();
    const { db } = db0();
    createRun(db, "run_w", "proj_w", "bb", "/w", "none", undefined, "h1");
    const calls: unknown[] = [];
    const host = { call: async (method: string, input: unknown) => { calls.push(input); return { path: "src/app.ts", content: "1", totalLines: 1, lineStart: 0, lineEnd: 0, truncated: false, sizeBytes: 1 }; } };
    const out = await workFileRead(db, host, { runId: "run_w", relativePath: "src/app.ts", offset: 10 });
    expect(out.content).toBe("1");
    expect(calls[0]).toMatchObject({ offset: 10, maxLines: 200 });
    await expect(workFileRead(db, host, { runId: "run_w", relativePath: "../x" })).rejects.toThrow(/refused/);
  });
});

describe("m_wrappers: transitionAttempt journals atomically", () => {
  it("state write and journal row land together and refusal is journaled", () => {
    const { db } = db0();
    createRun(db, "run_t", "proj_t");
    createTask(db, { id: "tt", runId: "run_t", kind: "bb", contract: {} });
    createAttempt(db, { id: "at", runId: "run_t", taskId: "tt" });
    expect(transitionAttempt(db, "at", "accepted", { reason: "done" })).toBe(true);
    expect(transitionAttempt(db, "at", "running", { reason: "no way back" })).toBe(false);
    const rows = attemptTransitionsForTask(db, "run_t", "tt");
    expect(rows.filter((row) => row.refused === 0).map((row) => row.to_state)).toContain("accepted");
    expect(rows.some((row) => row.refused === 1)).toBe(true);
  });
});

describe("m_sw_worker_history + m_sw_worker_card: outcomes and presence", () => {
  it("groups done/notDone per worker and day and reports running tasks", () => {
    const { db } = db0();
    createRun(db, "run_o", "proj_o");
    createTask(db, { id: "to", runId: "run_o", kind: "bb", contract: {} });
    createAttempt(db, { id: "ao1", runId: "run_o", taskId: "to" });
    createAttempt(db, { id: "ao2", runId: "run_o", taskId: "to" });
    saveReasoningTrace(db, { planSha256: "s", sentPlanSha256: null, sourceLength: 1, sentLength: null, jevStatus: "ok", jevDecision: null, requestedReasoningLevel: "m", effectiveReasoningLevel: "m", fallbackReason: null, providerId: "p1", model: "m1", serviceTier: null, requestedServiceTier: "default", runId: "run_o", attemptId: "ao1", threadId: null });
    saveReasoningTrace(db, { planSha256: "s", sentPlanSha256: null, sourceLength: 1, sentLength: null, jevStatus: "ok", jevDecision: null, requestedReasoningLevel: "m", effectiveReasoningLevel: "m", fallbackReason: null, providerId: "p1", model: "m1", serviceTier: null, requestedServiceTier: "default", runId: "run_o", attemptId: "ao2", threadId: null });
    transitionAttempt(db, "ao1", "accepted", {});
    transitionAttempt(db, "ao2", "spawn_requested", {});
    transitionAttempt(db, "ao2", "running", {});
    const outcomes = workerOutcomesSince(db, "proj_o", 0);
    const cell = outcomes.find((row) => row.providerId === "p1" && row.model === "m1");
    expect(cell).toMatchObject({ done: 1, notDone: 0 });
    const presence = workerPresenceNow(db, "proj_o", 0).find((row) => row.providerId === "p1");
    expect(presence).toMatchObject({ running: 1, taskIds: ["to"] });
    expect(presence!.lastAt).toBeGreaterThan(0);
  });
});

describe("ar_stamp + ar_run_dir: stamp and attempt dossier", () => {
  it("a trace carries the machine stamp and inspectAttempt returns the full dossier", () => {
    const { db } = db0();
    createRun(db, "run_d", "proj_d");
    createTask(db, { id: "td", runId: "run_d", kind: "bb", contract: {} });
    createAttempt(db, { id: "ad", runId: "run_d", taskId: "td" });
    saveReasoningTrace(db, { stamp: { stateMachineVersion: STATE_MACHINE_VERSION, harnessVersion: "x" }, planSha256: "s", sentPlanSha256: null, sourceLength: 1, sentLength: null, jevStatus: "ok", jevDecision: null, requestedReasoningLevel: "m", effectiveReasoningLevel: "m", fallbackReason: null, providerId: "p", model: "m", serviceTier: null, requestedServiceTier: "default", runId: "run_d", attemptId: "ad", threadId: "thr_w" });
    transitionAttempt(db, "ad", "spawn_requested", { reason: "go", threadId: "thr_w" });
    transitionAttempt(db, "ad", "running", { reason: "go" });
    expect(getReasoningTrace(db, "ad")?.stamp).toMatchObject({ stateMachineVersion: STATE_MACHINE_VERSION });
    const out = inspectAttempt(db, "proj_d", "ad");
    expect(out).not.toBeNull();
    const dossier = out!.dossier as Record<string, unknown>;
    expect(dossier.threadId).toBe("thr_w");
    expect((dossier.transitions as unknown[]).length).toBeGreaterThan(0);
    expect(dossier).toHaveProperty("stageReceipts");
    expect(dossier).toHaveProperty("gateEvents");
    expect(dossier).toHaveProperty("reasoningTrace");
    expect(dossier).toHaveProperty("verdict");
  });
});
