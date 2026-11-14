// Region 9 · Person and window, batch g — the server halves: the conveyor switch of the machines zone (n958), the window's commands of the phase door
// (n959) and the chat that is the PM thread (n957). Each test checks the whole value the card names; what was observed is also written down with observe()
// (tests/sma/r09-world-g.ts) for the region scene sma_r09.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CONVEYOR_KEY, conveyorStartLine, conveyorState, setConveyor } from "../../src/rooms/runs/conveyor";
import { phaseRpc } from "../../src/rooms/phase/server/rpc";
import { createWriterDispatch } from "../../src/rooms/writer/server/dispatch";
import { createRun, getTask, listAttemptsForTask, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { observe } from "./r09-world-g";

afterEach(() => { vi.useRealTimers(); });

const memoryKv = () => { const map = new Map<string, unknown>(); return { map, get: async (key: string) => map.get(key), set: async (key: string, value: unknown) => { map.set(key, value); } }; };

describe("region 9 · the machines zone", () => {
  it("[sma:sc_machines] switching the conveyor off stores when and why (the reason trimmed and cut at 300), a second «off» keeps the first word, «on» clears it, and the start line names the way out while it is off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T10:00:00.000Z"));
    const kv = memoryKv();
    const untouched = await conveyorState(kv);
    const off = await setConveyor(kv, false, "  deploy window  ");
    vi.setSystemTime(new Date("2026-11-14T11:30:00.000Z"));
    const again = await setConveyor(kv, false, "something else");
    const line = conveyorStartLine(again);
    expect(untouched).toEqual({ on: true, since: null, reason: null });
    expect(off).toEqual({ on: false, since: "2026-11-14T10:00:00.000Z", reason: "deploy window" });
    expect(again).toEqual(off);
    expect(kv.map.get(CONVEYOR_KEY)).toEqual({ at: Date.parse("2026-11-14T10:00:00.000Z"), reason: "deploy window" });
    expect(line).toBe("Lane Pilot: the conveyor is OFF since 2026-11-14T10:00:00.000Z (deploy window): no new work is issued. Turn it on with: bb lane-pilot conveyor on");
    const on = await setConveyor(kv, true);
    expect(on).toEqual({ on: true, since: null, reason: null });
    expect(conveyorStartLine(on)).toBeNull();
    const long = await setConveyor(kv, false, "x".repeat(400));
    expect(long.reason).toBe("x".repeat(300));
    await setConveyor(kv, true);
    const blank = await setConveyor(kv, false, "   ");
    expect(blank).toMatchObject({ on: false, reason: null });
    observe("n958", { untouched, off, secondOffChangesNothing: again.since === off.since && again.reason === off.reason, on, startLine: line, reasonCutAt: long.reason!.length, blankReason: blank.reason });
  });
});

// ---- n959 the window's commands ----
function fakePhase() {
  const calls: Array<[string, unknown]> = [];
  const note = (name: string, result: unknown) => (input: unknown) => { calls.push([name, input]); return result; };
  const async = (name: string, result: unknown) => async (input: unknown) => note(name, result)(input);
  const api = {
    status: (id: string) => ({ phase: { id, state: "active", stage: "execution" }, next: { text: "n" }, gates: {}, book: "", facts: {} }),
    setState: note("setState", { id: "ph1" }), stopWave: async("stopWave", { stopped: ["t1"] }), stop: async("stop", { phase: { id: "ph1" } }), word: async("word", { id: "ph1" }),
    returnTo: note("returnTo", { id: "ph1" }), answer: note("answer", { id: "ph1" }),
  };
  return { api: api as never, calls };
}

describe("region 9 · the window's commands", () => {
  it("[sma:sc_console] the window's commands reach the phase door as the card lists them: pause and resume set the state, a wave is dequeued, a stage return and the owner's word carry their words, an answer settles its question as the owner's, and «close» without words is refused", async () => {
    const { api, calls } = fakePhase();
    const rpc = phaseRpc(api) as unknown as Record<string, (input: Record<string, unknown>) => Promise<Record<string, unknown>>>;
    await rpc.phase_control!({ phaseId: "ph1", action: "pause" });
    await rpc.phase_control!({ phaseId: "ph1", action: "resume" });
    const wave = await rpc.phase_control!({ phaseId: "ph1", action: "stop_wave" });
    await rpc.phase_control!({ phaseId: "ph1", action: "word", turn: "wave", decision: "no", wave: 2, note: "  the header is missing  " });
    await rpc.phase_control!({ phaseId: "ph1", action: "return", to: "planning", note: "plan again" });
    await rpc.phase_act!({ action: "answer", phaseId: "ph1", projectId: "p1", pmThreadId: "screen", payload: { questionId: "q1", answer: "yes, go on" } });
    await rpc.phase_control!({ phaseId: "ph1", action: "close", note: "done by hand" });
    const refused = await rpc.phase_control!({ phaseId: "ph1", action: "close" }).then(() => null, (cause: Error) => cause.message);
    expect(calls).toEqual([
      ["setState", { phaseId: "ph1", state: "pause", words: undefined, by: "owner" }],
      ["setState", { phaseId: "ph1", state: "resume", words: undefined, by: "owner" }],
      ["stopWave", { phaseId: "ph1", by: "owner" }],
      ["word", { phaseId: "ph1", turn: "wave", decision: "no", text: "the header is missing", wave: 2, useful: undefined, limits: undefined, key: undefined, by: "owner via screen" }],
      ["returnTo", { phaseId: "ph1", to: "planning", note: "plan again", by: "owner" }],
      ["answer", { phaseId: "ph1", questionId: "q1", answer: "yes, go on", by: "owner via screen" }],
      ["setState", { phaseId: "ph1", state: "close", words: "done by hand", by: "owner" }],
    ]);
    expect(wave).toMatchObject({ stopped: ["t1"], status: { phase: { id: "ph1" } } });
    expect(refused).toBe("closing in words carries the words");
    observe("n959", { commands: calls.map(([name, input]) => [name, (input as { state?: string; questionId?: string }).state ?? (input as { questionId?: string }).questionId ?? null]), answerBy: (calls[5]![1] as { by: string }).by, closeWithoutWords: refused });
  });
});

// ---- n957 the chat is the PM thread ----
function dispatchWorld(metadata: Record<string, unknown>, withRun = true) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { files: { write: async () => ({ ok: true }) } } });
  const db = openDatabase(bb);
  if (withRun) { createRun(db, "run-1", "proj-1", "bb", "/ws"); setRunThread(db, "run-1", "pm-1"); }
  const config = { projectId: "proj-1", hostId: "h1", pmWorkspacePath: "/ws", writerWorkspacePath: "/ws", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" };
  const engine = {
    resolveWorkflow: () => ({ id: "lp-task-pipeline" }), preflight: () => [],
    start: () => ({ runId: "wf-1", done: Promise.resolve({ status: "waiting", waiting: [{ partial: { reply: { state: "queued", stagesPending: true } } }] }) }),
  };
  const ctx = {
    bb: { ...bb, sdk: { ...bb.sdk, threads: { getPluginMetadata: async () => metadata }, files: { write: async () => ({ ok: true }) } } }, db, log: () => undefined,
    host: { call: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }, configForRun: async () => config, ensureRunScopes: async () => undefined, refreshRun: () => undefined,
    getThreadBounded: async () => null, acceptedTaskWorkspace: async () => null,
  };
  const services = { workflowEngine: engine, isLiveFolder: async () => false, activeWriterTasks: new Set(), runBudgets: { get: () => undefined }, wall: undefined, stageHelperSettings: async () => ({}), resolveIntegrationGate: async () => ({ command: null, source: "none" }), stability: { dropParked: async () => [], loadParked: async () => [] }, isTaskSatisfied: async () => false };
  const dispatch = createWriterDispatch(ctx as never, services as never);
  return { db, harness, dispatch };
}
const contract = (id: string) => ({ schema_version: 2 as const, id, kind: "feature" as const, area: "feature:form", title: id, display_title: "The form saves", risk: "low" as const, lane: "writer" as const, project_cwd: "/ws", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["a/out.ts"], owns_paths: ["a/**"], never_touch: [], depends_on: [], objective: "The form saves", acceptance: ["the form saves"], verify: "tests", verification: [] });

describe("region 9 · the chat", () => {
  it("[sma:sc_chat] the owner's chat is the PM's thread: the PM puts the task itself — a task and a queued attempt appear in the run — while any other thread is refused with the same words and creates nothing", async () => {
    const pm = dispatchWorld({ role: "pm", lanePilotRunId: "run-1" });
    const placed = await pm.dispatch.dispatchWriter({ threadId: "pm-1", projectId: "proj-1", task: contract("t1"), objective: "The form saves" } as never);
    const attempts = listAttemptsForTask(pm.db, "run-1", "t1");
    expect(placed).toMatchObject({ state: "queued" });
    const stored = getTask(pm.db, "t1")?.contract as { id: string; objective: string; owns_paths: string[] };
    expect(stored).toMatchObject({ id: "t1", objective: "The form saves", owns_paths: ["a/**"] });
    expect(attempts.map((row) => row.state)).toEqual(["queued"]);
    await pm.harness.lifecycle.dispose();
    const writer = dispatchWorld({ role: "writer", lanePilotRunId: "run-1" });
    const refused = await writer.dispatch.dispatchWriter({ threadId: "thr-writer", projectId: "proj-1", task: contract("t2") } as never).then(() => null, (cause: Error) => cause.message);
    expect(refused).toBe("caller is not a Lane Pilot PM thread");
    expect(listAttemptsForTask(writer.db, "run-1", "t2")).toEqual([]);
    expect(writer.db.prepare("SELECT id FROM lane_pilot_task WHERE id = ?").get("t2")).toBeUndefined();
    await writer.harness.lifecycle.dispose();
    const loose = dispatchWorld({ role: "pm" });
    const noRun = await loose.dispatch.dispatchWriter({ threadId: "pm-1", projectId: "proj-1", task: contract("t3") } as never).then(() => null, (cause: Error) => cause.message);
    expect(noRun).toBe("PM thread has no lanePilotRunId");
    await loose.harness.lifecycle.dispose();
    observe("n957", { placed: { state: (placed as { state: string }).state, task: stored.id, attempts: attempts.map((row) => row.state) }, otherThread: refused, otherThreadTasks: 0, pmWithoutRun: noRun });
  });
});
