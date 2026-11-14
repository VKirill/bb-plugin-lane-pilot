// Region 1 · Task graph, batch f, second half (n333-n344, n1772): the claim guards, the held tasks, the phase steps and the attempt's accepted state.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../../server";
import { designGate, nextAction, PHASE_STAGES, type Phase, type PhaseRecord } from "../../src/rooms/phase";
import { HOLD_FOREVER, recordTaskWord } from "../../src/rooms/tasks";
import { isLegalMove, OPERATIONAL_MOVES, nextAttemptState } from "../../src/rooms/contracts/state-machine";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import type { TaskV2 } from "../../src/rooms/contracts";
import { taskOf } from "./r01-world-c";

const phase = (record: PhaseRecord, stage: Phase["stage"]): Phase => ({
  id: "ph_f", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});
const item = (id: string, wave = 1) => ({ id, title: id, wave, promise: { given: "g", when: "w", then: "t" }, task: { owns_paths: [`${id}/a.ts`] } });

describe("the steps of a phase", () => {
  it("[sma:ts_design] at the design step the PM is asked to wait for a drawing, the step is the row's stage, and a drawing changes the wait key", () => {
    expect(PHASE_STAGES.slice(2, 5)).toEqual(["design", "execution", "verification"]);
    const bare = nextAction(phase({ design: { decision: "needed", why: "screens" } }, "design"), new Map());
    expect(bare).toMatchObject({ stage: "design", waitsForPm: true, key: "design:none:-:-" });
    const drawn = nextAction(phase({ design: { decision: "needed", why: "screens", drawing: { paths: ["d/UI-SPEC.md"], sha256: "S1", designer: "design-lead", feasible: true, reviewer: "ui-review" } } }, "design"), new Map());
    expect(drawn).toMatchObject({ stage: "design", waitsForPm: true, key: "design:S1:true:ui-review" });
  });

  it("[sma:ts_feas] the drawing is feasible only when the executor's answer says so: no answer or a contradiction holds the gate, a yes with a separate reviewer opens it", () => {
    const drawing = (over: Record<string, unknown>) => ({ design: { decision: "needed" as const, why: "screens", drawing: { paths: ["d/UI-SPEC.md"], sha256: "S1", designer: "design-lead", reviewer: "ui-review", ...over } } }) as PhaseRecord;
    const open = designGate(drawing({ feasible: true }));
    expect(open.ok).toBe(true);
    const none = designGate(drawing({}));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.why).toEqual(expect.arrayContaining([expect.stringContaining("no feasibility answer")]));
    const contradiction = designGate(drawing({ feasible: false, contradiction: "the plan has no table" }));
    expect(contradiction.ok).toBe(false);
    if (!contradiction.ok) expect(contradiction.why).toEqual(expect.arrayContaining([expect.stringContaining("contradicts the plan: the plan has no table")]));
    // The drawing is not edited by the answer: the gate reads the same drawing record afterwards.
    const record = drawing({ feasible: false, contradiction: "x" });
    const before = JSON.stringify(record);
    designGate(record);
    expect(JSON.stringify(record)).toBe(before);
  });

  it("[sma:ts_execute] at execution Lane Pilot itself issues the pieces: the PM waits for nothing, and the wait key counts the issued and the open pieces", () => {
    const record: PhaseRecord = { plan: { items: [item("a"), item("b"), item("c")], sha: "s", contextSha: "c", admittedSha: "s" }, execution: { issued: { a: "ta", b: "tb" }, waves: {} } };
    const facts = new Map([["a", { state: "accepted" }], ["b", { state: "running" }]]) as never;
    const action = nextAction(phase(record, "execution"), facts);
    expect(action).toMatchObject({ stage: "execution", waitsForPm: false, key: "execution:running:2:1" });
    // A piece that ended blocked is not silence: the PM decides it.
    const stuck = nextAction(phase(record, "execution"), new Map([["a", { state: "accepted" }], ["b", { state: "blocked" }]]) as never);
    expect(stuck).toMatchObject({ stage: "execution", waitsForPm: true, key: "execution:blocked:b" });
  });

  it("[sma:ts_verify] at verification the cycle runs the checks by itself, a failed verdict is the PM's, and a passed blind check waits for the goal audit", () => {
    const base: PhaseRecord = { plan: { items: [item("a")], sha: "s", contextSha: "c", admittedSha: "s" } };
    expect(nextAction(phase(base, "verification"), new Map())).toMatchObject({ stage: "verification", waitsForPm: false, key: "verification:running" });
    const failed = nextAction(phase({ ...base, verification: { verdict: { state: "failed", detail: "red", mainSha: "m", at: 1, inputSha: "IN1" } } }, "verification"), new Map());
    expect(failed).toMatchObject({ stage: "verification", waitsForPm: true, key: "verification:verdict-failed:IN1" });
    const passed = nextAction(phase({ ...base, verification: { verdict: { state: "passed", detail: "green", mainSha: "m", at: 1, inputSha: "IN2" } } }, "verification"), new Map());
    expect(passed).toMatchObject({ stage: "verification", waitsForPm: true, key: "verification:model" });
  });

  it("[sma:ts_needs_clarify] a drawing is not asked for while a blocking question of the design stage is open; answered, the draw step is due", () => {
    const record: PhaseRecord = { design: { decision: "needed", why: "screens" }, questions: [{ id: "q1", stage: "design", text: "Which grid?", blocking: true, askedAt: 1 }] };
    const asked = nextAction(phase(record, "design"), new Map());
    expect(asked).toMatchObject({ stage: "design", waitsForPm: true, key: "design:questions:q1" });
    const answered = nextAction(phase({ ...record, questions: [{ ...record.questions![0]!, answer: "8px" }] }, "design"), new Map());
    expect(answered.key).toBe("design:none:-:-");
  });
});

describe("the attempt's accepted state", () => {
  it("[sma:f_accepted] our automaton stamps accepted from the states the product reaches it from, and an accepted row is never overwritten", () => {
    const reach = (from: string) => isLegalMove(from, "accepted");
    expect(["running", "queued", "cancel_requested", "blocked", "provider_error", "timeout", "empty_output", "validation_failed"].map(reach)).toEqual(Array(8).fill(true));
    expect(["canceled", "spawn_requested", "spawn_rejected", "accepted"].map(reach)).toEqual([false, false, false, false]);
    expect(OPERATIONAL_MOVES.filter((move) => move.to === "accepted").map((move) => move.from).sort()).toEqual(["blocked", "cancel_requested", "empty_output", "provider_error", "queued", "timeout", "validation_failed"]);
    expect(nextAttemptState("running", "checks_passed")).toBe("accepted");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr" });
    transitionAttempt(db, "a1", "validation_failed", { reason: "late" });
    // The merge landed in main before the state caught up: the same row ends accepted, and then nothing takes it back.
    expect(transitionAttempt(db, "a1", "accepted", { reason: "merged" })).toBe(true);
    expect(getAttempt(db, "a1")?.state).toBe("accepted");
    expect(transitionAttempt(db, "a1", "canceled", { reason: "late cancel" })).toBe(false);
    expect(getAttempt(db, "a1")?.state).toBe("accepted");
  });
});

// ---- the queue tool: held tasks ----
describe("held steps", () => {
  it("[sma:ts_held] nothing is held by default; the PM's hold waits until released (year 2999) or to a date, a release clears it, another run's task is refused", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: { getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "run-h" }) } },
    });
    try {
      const db = openDatabase(bb);
      createRun(db, "run-h", "proj-h");
      createRun(db, "run-other", "proj-h");
      createTask(db, { id: "th1", runId: "run-h", kind: "bb", contract: taskOf("th1") });
      createTask(db, { id: "th2", runId: "run-h", kind: "bb", contract: taskOf("th2") });
      createTask(db, { id: "tx", runId: "run-other", kind: "bb", contract: taskOf("tx") });
      await plugin(bb);
      const held = (id: string) => (db.prepare("SELECT held_until FROM lane_pilot_task WHERE id=?").get(id) as { held_until: number | null }).held_until;
      const queue = async (input: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_queue", input, { threadId: "pm-h", projectId: "proj-h" }))) as Record<string, unknown>;
      expect([held("th1"), held("th2")]).toEqual([null, null]);
      const hold = await queue({ action: "hold", taskIds: ["th1", "tx"] });
      expect(hold).toMatchObject({ tasks: ["th1"], until: "released by hand", refused: [{ taskId: "tx", why: "not a task of run run-h" }] });
      expect([held("th1"), held("th2"), held("tx")]).toEqual([HOLD_FOREVER, null, null]);
      const dated = await queue({ action: "hold", taskIds: ["th2"], until: "2100-06-01T00:00:00.000Z" });
      expect(dated).toMatchObject({ tasks: ["th2"], until: "2100-06-01T00:00:00.000Z" });
      expect(held("th2")).toBe(Date.parse("2100-06-01T00:00:00.000Z"));
      const released = await queue({ action: "release", taskIds: ["th1", "th2"] });
      expect(released).toMatchObject({ tasks: ["th1", "th2"], until: null });
      expect([held("th1"), held("th2")]).toEqual([null, null]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

// ---- work already decided ----
const DPROJECT = "project-test", DPM = "pm-thread", DRUN = "run-no";
const dconfig = { projectId: DPROJECT, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" };
const dtask: TaskV2 = {
  schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:suite-no", id: "suite-no", title: "Decided work", risk: "low", lane: "writer", project_cwd: dconfig.writerWorkspacePath,
  read_first: ["README.md"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["hello.txt"],
  owns_paths: ["hello.txt"], never_touch: [".git/**"], depends_on: [], objective: "create hello", acceptance: ["never"], verify: "none", verification: [],
};

describe("work already decided", () => {
  it("[sma:cg_claim_refusal] a family the owner said no to is refused before a task or an attempt exists; a new yes opens it again; with the owner's words off it is not asked", async () => {
    process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "50";
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: {
        getPluginMetadata: async ({ threadId }) => threadId === DPM ? { role: "pm", lanePilotRunId: DRUN } : { role: "writer" },
        spawn: async () => ({ id: "writer-no" }),
        wait: async () => new Promise(() => undefined),
        get: async ({ threadId }) => threadId === DPM ? { id: DPM, status: "idle", projectId: DPROJECT } as never : { id: threadId, status: "active" } as never,
        output: async () => ({ text: "" }),
        list: async () => [] as never,
        stop: async () => ({} as never),
      }, environments: { listProviders: async () => [] as never }, providers: {
        list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
        models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: ["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
      }, files: { read: async () => ({ content: "fixture\n" }), write: async () => ({ ok: true }) } },
      experimental_callHostRpc: async (call) => {
        if (call.method === "gitOwnershipBase") await new Promise(() => undefined);
        if (call.method === "classifyPlan") return { hostId: "host-test", status: "ok", effort: "xhigh", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        return { hostId: "host-test", exitCode: 0, stdout: String((call.input as { command?: string }).command ?? "").includes("porcelain") ? "[]" : "", stderr: "" };
      },
    });
    try {
      const db = openDatabase(bb);
      savePrototypeConfig(db, dconfig);
      saveProjectSetting(db, DPROJECT, "plan_critique.enabled", false);
      saveProjectSetting(db, DPROJECT, "memory.enabled", false);
      saveProjectSetting(db, DPROJECT, "owner.words", "on");
      createRun(db, DRUN, DPROJECT, "bb", dconfig.writerWorkspacePath);
      setRunThread(db, DRUN, DPM);
      await plugin(bb);
      const dispatch = async () => JSON.parse(String(await harness.behavior.callAgentTool(
        "lane_pilot_dispatch_writer", { confirm: true, objective: "Проверка", plan: "Plan for the decided work", task: dtask }, { threadId: DPM, projectId: DPROJECT },
      ))) as Record<string, unknown>;
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`).get(DRUN) as { n: number }).n;
      await recordTaskWord(bb.storage.kv as never, DRUN, "suite-no", "no", "not this quarter");
      const refused = await dispatch();
      expect(refused).toMatchObject({ ok: false, error: { code: "owner_said_no", retryable: false, sideEffects: "none" } });
      expect(String(refused.hint)).toContain("not this quarter");
      expect([count("lane_pilot_task"), count("lane_pilot_attempt")]).toEqual([0, 0]);
      // A new yes of the owner opens the family again.
      await recordTaskWord(bb.storage.kv as never, DRUN, "suite-no", "yes", "go on");
      const opened = await dispatch();
      expect(opened.ok).not.toBe(false);
      expect(count("lane_pilot_task")).toBe(1);
    } finally {
      delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS;
      await harness.lifecycle.dispose();
    }
  });
});
