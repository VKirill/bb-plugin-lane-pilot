import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { HEAVY_WITHOUT_JEV, intakeByRules, isMachineMessage } from "../src/rooms/phase/intake";
import { createPhaseIntake, type IntakePhases } from "../src/rooms/phase/server/intake";
import type { Phase } from "../src/rooms/phase/logic";
import { createRun, openDatabase } from "../src/rooms/storage";

const PM = "thr_pm";
const goal = `Нужно сделать раздел блога заново: авторы, категории, поиск, SEO-разметка каждой страницы, перенос старых статей и редиректы. ${"Подробности и требования к каждому экрану. ".repeat(20)}`;

function world(options: { settings?: Record<string, unknown>; role?: string } = {}) {
  let request = { requestId: "creq_1", initiator: "user", input: [{ type: "text", text: goal }] } as Record<string, unknown>;
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: options.role ?? "pm", lanePilotRunId: "run1" }));
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: request }]);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  const opened: Phase[] = [];
  const phases: IntakePhases = {
    open: async (input) => {
      expect(input.rails).toBe(true);
      const phase = { id: `ph_${opened.length + 1}`, projectId: input.projectId, pmThreadId: input.pmThreadId, runId: "run1", title: input.title, goal: input.goal,
        stage: "discussion", state: "active", record: {}, edition: 1, createdAt: 1, updatedAt: 1 } as unknown as Phase;
      opened.push(phase);
      return phase;
    },
    tick: async () => 0,
    list: (filter) => opened.filter((phase) => (!filter.pmThreadId || phase.pmThreadId === filter.pmThreadId) && (!filter.live || !["closed", "stopped"].includes(phase.state))),
    status: () => ({ next: { text: "write the discussion files and report them with context" } }),
  };
  const intake = createPhaseIntake({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: options.settings ?? {} }) } as never, phases);
  return { intake, opened, say: (text: string, id: string, initiator = "user") => { request = { requestId: id, initiator, input: [{ type: "text", text }] }; } };
}

describe("phase intake rules", () => {
  it("settles a consent and a short message in code, and leaves a long one to the judgment", () => {
    expect(intakeByRules("да")).toEqual({ kind: "consent", confident: true });
    expect(intakeByRules("поправь опечатку в футере")).toEqual({ kind: "small", confident: false });
    expect(intakeByRules("почему не грузится каталог?")).toEqual({ kind: "question", confident: true });
    expect(intakeByRules("x".repeat(HEAVY_WITHOUT_JEV + 1))).toEqual({ kind: "heavy", confident: false });
    expect(intakeByRules(`a\n${"b".repeat(200)}`)).toEqual({ kind: "small", confident: false });
  });
  it("knows Lane Pilot's own notices", () => {
    expect(isMachineMessage("Lane Pilot: results of your tasks")).toBe(true);
    expect(isMachineMessage("[Lane Pilot phase] Phase ph_1 …")).toBe(true);
    expect(isMachineMessage("[bb message from thread:thr_x]\n…")).toBe(true);
    expect(isMachineMessage("надо сделать вход")).toBe(false);
  });
});

describe("rails by default", () => {
  it("a heavy owner goal opens a phase once, and the PM may not dispatch its work by hand", async () => {
    const { intake, opened } = world();
    const record = await intake.take(PM);
    expect(record).toMatchObject({ kind: "heavy", phaseId: "ph_1" });
    expect(opened[0]!.title.length).toBeLessThanOrEqual(80);
    expect(await intake.take(PM)).toMatchObject({ phaseId: "ph_1" });
    expect(opened).toHaveLength(1);
    expect(await intake.dispatchRefusal(PM)).toMatch(/phase ph_1 .*write the discussion files/);
  });
  it("a small request after it is dispatched as before, and the phase stays", async () => {
    const { intake, opened, say } = world();
    await intake.take(PM);
    say("поправь опечатку в футере", "creq_2");
    expect(await intake.dispatchRefusal(PM)).toBeNull();
    expect(opened).toHaveLength(1);
  });
  it("Lane Pilot's own notices and agents' messages do not change the owner's request", async () => {
    const { intake, say } = world();
    await intake.take(PM);
    say("Lane Pilot: results of your tasks", "creq_3");
    expect(await intake.dispatchRefusal(PM)).toMatch(/phase ph_1/);
    say("поправь опечатку", "creq_4", "agent");
    expect(await intake.dispatchRefusal(PM)).toMatch(/phase ph_1/);
  });
  it("a paused phase still holds the request; only a closed one lets the PM dispatch", async () => {
    const { intake, opened } = world();
    await intake.take(PM);
    (opened[0] as { state: string }).state = "paused";
    expect(await intake.dispatchRefusal(PM)).toMatch(/phase ph_1/);
    (opened[0] as { state: string }).state = "closed";
    expect(await intake.dispatchRefusal(PM)).toBeNull();
  });
  it("the phase is opened as a rails phase", async () => {
    const { intake, opened } = world();
    await intake.take(PM);
    expect(opened).toHaveLength(1);
  });
  it("a second heavy message joins the live phase instead of opening another", async () => {
    const { intake, opened, say } = world();
    await intake.take(PM);
    say(`${goal} И ещё добавить RSS.`, "creq_5");
    expect(await intake.take(PM)).toMatchObject({ kind: "heavy", phaseId: "ph_1" });
    expect(opened).toHaveLength(1);
  });
  it("phase.rails off, or a chat that is not a PM's, is left alone", async () => {
    const off = world({ settings: { "phase.rails": "off" } });
    expect(await off.intake.take(PM)).toBeNull();
    expect(off.opened).toHaveLength(0);
    const writer = world({ role: "writer" });
    expect(await writer.intake.take(PM)).toBeNull();
  });
});

describe("a new process", () => {
  it("is pointed at the forge once, then the PM may dispatch", async () => {
    const { createPhaseIntake: create } = await import("../src/rooms/phase/server/intake");
    const { createFakePluginHost: host } = await import("@get-bb/plugin-sdk/testing");
    const { bb, harness } = host({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: { requestId: "creq_p", initiator: "user", input: [{ type: "text", text: "x".repeat(300) }] } }]);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const phases = { open: async () => { throw new Error("no phase for a process"); }, tick: async () => 0, list: () => [], status: () => ({ next: { text: "" } }) };
    const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: {} }) } as never, phases as never);
    // The newest request was read earlier as a process (the record the reader keeps).
    await bb.storage.kv.set("phase-intake:thr_pm", { requestId: "creq_p", kind: "process", by: "jev", phaseId: null, at: 1 });
    expect(await intake.dispatchRefusal("thr_pm")).toMatch(/lane_pilot_forge/);
    expect(await intake.dispatchRefusal("thr_pm")).toBeNull();
  });
});

describe("the small-task graph", () => {
  it("is started by the machine on the judgment's word, and the PM does not dispatch that request by hand", async () => {
    const { createPhaseIntake: create } = await import("../src/rooms/phase/server/intake");
    const { createFakePluginHost: host } = await import("@get-bb/plugin-sdk/testing");
    const { bb, harness } = host({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: { requestId: "creq_s", initiator: "user", input: [{ type: "text", text: "поправь опечатку в футере" }] } }]);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const started: string[] = [];
    const phases = { open: async () => { throw new Error("no phase"); }, tick: async () => 0, list: () => [], status: () => ({ next: { text: "" } }) };
    const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: {} }) } as never, phases as never,
      { start: (input) => { started.push(input.text); return "wfrun_1"; }, status: () => "running" });
    (intake as { classify: unknown }).classify = undefined;
    // No Jev here: the length rule alone does not start a build.
    expect(await intake.take("thr_pm")).toMatchObject({ kind: "small", by: "rules" });
    expect(started).toEqual([]);
    expect(await intake.dispatchRefusal("thr_pm")).toBeNull();
    // Read with the judgment's word, the request is the graph's: dispatching it by hand is refused while the run works.
    await bb.storage.kv.set("phase-intake:thr_pm", { requestId: "creq_s", kind: "small", by: "jev", phaseId: null, at: 1, wfRunId: "wfrun_1" });
    expect(await intake.dispatchRefusal("thr_pm")).toMatch(/small-task graph[\s\S]*wfrun_1/);
    // Read with the judgment's word, the request is the graph's: dispatching it by hand is refused while the run works.
    await bb.storage.kv.set("phase-intake:thr_pm", { requestId: "creq_s", kind: "small", by: "jev", phaseId: null, at: 1, wfRunId: "wfrun_1" });
    expect(await intake.dispatchRefusal("thr_pm")).toMatch(/small-task graph[\s\S]*wfrun_1/);
  });
});

describe("the PM is the door: no other system for a request the machine took", () => {
  it("refuses a route or a run while the graph or the architect works, and lets the architect's chain be routed once it is built", async () => {
    const { createPhaseIntake: create } = await import("../src/rooms/phase/server/intake");
    const { createFakePluginHost: host } = await import("@get-bb/plugin-sdk/testing");
    const { bb, harness } = host({ pluginId: "lane-pilot" });
    let architect = "running";
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: { requestId: "creq_p", initiator: "user", input: [{ type: "text", text: "x".repeat(300) }] } }]);
    harness.sdk.stub("threads.get", async () => ({ id: "thr_arch", status: architect }));
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const phases = { open: async () => { throw new Error("no phase"); }, tick: async () => 0, list: () => [], status: () => ({ next: { text: "" } }) };
    const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: {} }) } as never, phases as never,
      { start: () => "wfrun_1", status: () => "running" });
    await bb.storage.kv.set("phase-intake:thr_pm", { requestId: "creq_p", kind: "small", by: "jev", phaseId: null, at: 1, wfRunId: "wfrun_1" });
    expect(await intake.launchRefusal("thr_pm")).toMatch(/small-task graph/);
    await bb.storage.kv.set("phase-intake:thr_pm", { requestId: "creq_p", kind: "process", by: "jev", phaseId: null, at: 1, architectThreadId: "thr_arch" });
    expect(await intake.launchRefusal("thr_pm")).toMatch(/workflow architect/);
    architect = "idle";
    expect(await intake.launchRefusal("thr_pm")).toBeNull();
    expect(await intake.dispatchRefusal("thr_pm")).toMatch(/workflow architect/);
    // The process hint is the dispatch's: a route does not use it up.
    await bb.storage.kv.set("phase-intake:thr_pm", { requestId: "creq_p", kind: "process", by: "jev", phaseId: null, at: 1 });
    expect(await intake.launchRefusal("thr_pm")).toBeNull();
    expect(await intake.dispatchRefusal("thr_pm")).toMatch(/lane_pilot_forge/);
  });
});

describe("a reply about work under way", () => {
  it("is a kind of its own the judgment can choose, read against the PM's last message, and starts nothing", async () => {
    const { intakeJudgment } = await import("../src/rooms/phase/intake");
    const state = intakeJudgment.stateBuilder({ text: "так сам авторизовывайся, нажми sign in", previous: "Studio вышла из аккаунта. Войти через Chrome?" }) as Record<string, string>;
    expect(state.pm_last_message).toMatch(/Studio/);
    expect(JSON.stringify(intakeJudgment.questions({ text: "x" }))).toContain("reply");
    const decided = intakeJudgment.decide({ weight: { type: "choice", probabilities: { reply: 0.8, small: 0.2 } } } as never, { min_p: 0.55 }, { text: "x" });
    expect(decided.decision).toEqual({ kind: "reply" });
  });
});
