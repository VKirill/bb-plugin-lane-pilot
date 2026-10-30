import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { HEAVY_WITHOUT_JEV, intakeByRules, intakeRunGoals, isMachineMessage } from "../src/rooms/phase/intake";
import { createPhaseIntake, type IntakePhases, type IntakeTrain } from "../src/rooms/phase/server/intake";
import type { Phase } from "../src/rooms/phase/logic";
import { createRun, openDatabase } from "../src/rooms/storage";
import { pmPrompt } from "../src/rooms/core/server/pm-spawn";
import type { PrototypeConfig } from "../src/rooms/contracts";
import bootstrapEvents from "./fixtures/phase-intake-pm-bootstrap-2026-10-29.json";

const PM = "thr_pm";
const goal = `Нужно сделать раздел блога заново: авторы, категории, поиск, SEO-разметка каждой страницы, перенос старых статей и редиректы. ${"Подробности и требования к каждому экрану. ".repeat(20)}`;

function world(options: { settings?: Record<string, unknown>; role?: string; train?: IntakeTrain; request?: Record<string, unknown> } = {}) {
  let request = options.request ?? { requestId: "creq_1", initiator: "user", input: [{ type: "text", text: goal }] } as Record<string, unknown>;
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
  const deps = { bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: options.settings ?? {} }) } as never;
  const intake = createPhaseIntake(deps, phases, options.train);
  /** The plugin after a reload: a new intake over the same store and the same phases. */
  const reloaded = () => createPhaseIntake(deps, phases, options.train);
  return { intake, reloaded, opened, say: (text: string, id: string, initiator = "user") => { request = { requestId: id, initiator, input: [{ type: "text", text }] }; } };
}

describe("phase intake rules", () => {
  it("settles a consent and a short message in code, and leaves a long one to the judgment", () => {
    expect(intakeByRules("да")).toEqual({ kind: "consent", confident: true });
    expect(intakeByRules("поправь опечатку в футере")).toEqual({ kind: "small", confident: false });
    expect(intakeByRules("почему не грузится каталог?")).toEqual({ kind: "question", confident: true });
    expect(intakeByRules("x".repeat(HEAVY_WITHOUT_JEV + 1))).toEqual({ kind: "heavy", confident: false });
    expect(intakeByRules(`a\n${"b".repeat(200)}`)).toEqual({ kind: "small", confident: false });
  });
  it("F-006: a user intake names one goal from the request", () => {
    expect(intakeRunGoals("поправь кнопку в шапке")).toEqual([{
      id: "request", done_when: "The owner's request is done: поправь кнопку в шапке",
      evidence: "the workflow output status is closed and its comment says what changed", guess: true,
    }]);
    expect(intakeRunGoals("   ")).toEqual([expect.objectContaining({ id: "request", done_when: "The owner's request is done: Owner's request" })]);
  });
  it("knows Lane Pilot's own notices", () => {
    expect(isMachineMessage("Lane Pilot: results of your tasks")).toBe(true);
    expect(isMachineMessage("[Lane Pilot phase] Phase ph_1 …")).toBe(true);
    expect(isMachineMessage("[bb message from thread:thr_x]\n…")).toBe(true);
    expect(isMachineMessage("надо сделать вход")).toBe(false);
    // A workflow run's end notice started the next issue-quick, whose notice started the next (live 2026-10-26, Vampirism Fire).
    expect(isMachineMessage("Workflow run wfrun_a018031b894f42758ee7767e61b7debc of issue-quick is succeeded.\nNext: call lane_pilot_workflow_status")).toBe(true);
    expect(isMachineMessage("Workflow run in the docs is broken, fix it")).toBe(false);
  });
});

describe("rails by default", () => {
  it.each(bootstrapEvents)("does not analyze the live PM bootstrap $threadId as an owner's goal", async (event) => {
    const started: string[] = [];
    const { intake, opened, say } = world({ request: event.data,
      train: { start: (input) => { started.push(input.text); return "wfrun_unwanted"; }, status: () => "running" } });
    expect(await intake.take(PM)).toBeNull();
    expect(opened).toHaveLength(0);
    expect(started).toHaveLength(0);
    expect(await intake.dispatchRefusal(PM)).toBeNull();
    say(goal, "creq_real_owner");
    expect(await intake.take(PM)).toMatchObject({ kind: "heavy", phaseId: "ph_1" });
  });
  it.each([[false, false, false], [false, false, true], [true, false, true], [false, true, true]])(
    "leaves the PM activation instruction alone (managed=%s, native=%s, guarded=%s)", async (managed, native, guarded) => {
      const text = pmPrompt("lprun_bootstrap", { writerWorkspacePath: "/home/ubuntu/lp-drill-sandbox" } as PrototypeConfig, managed, native, guarded);
      const { intake, opened } = world({ request: { source: "spawn", requestId: "creq_bootstrap", initiator: "user", input: [{ type: "text", text }] } });
      expect(await intake.take(PM)).toBeNull();
      expect(opened).toHaveLength(0);
    });
  it("still reads a real owner's goal in the spawn of a native PM chat", async () => {
    const { intake } = world({ request: { source: "spawn", requestId: "creq_native", initiator: "user", input: [{ type: "text", text: goal }] } });
    expect(await intake.take(PM)).toMatchObject({ kind: "heavy", phaseId: "ph_1" });
  });
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

describe("a stopped or paused run", () => {
  it("starts no build on the judgment's word: the PM reads the message instead (live 2026-10-26, Vampirism Fire)", async () => {
    const { createPhaseIntake: create } = await import("../src/rooms/phase/server/intake");
    const { createFakePluginHost: host } = await import("@get-bb/plugin-sdk/testing");
    const { setJevForTests } = await import("@lane-pilot/jev");
    const { setRunPaused } = await import("../src/rooms/runs/server/runs-halt");
    const { bb, harness } = host({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: { requestId: "creq_x", initiator: "user", input: [{ type: "text", text: "проверь скриптами, что осталось" }] } }]);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const started: string[] = [];
    const phases = { open: async () => { throw new Error("no phase"); }, tick: async () => 0, list: () => [], status: () => ({ next: { text: "" } }) };
    setJevForTests({ enabled: () => true, judge: async () => ({ by: "jev", decision: { kind: "small" } }) } as never);
    try {
      const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: {} }) } as never, phases as never,
        { start: (input) => { started.push(input.text); return "wfrun_1"; }, status: () => "running" });
      await setRunPaused(bb.storage.kv as never, "run1", true);
      expect(await intake.take("thr_pm")).toMatchObject({ kind: "small", by: "jev" });
      expect(started).toEqual([]);
    } finally { setJevForTests(null); }
  });
});

describe("one stop check guards every machine start in the intake", () => {
  const texts = { heavy: goal, small: "поправь цвет кнопки", batch: "исправь список: 1) футер 2) шапка 3) меню", process: "сделай процесс: каждый день собирай отчёт и отправляй" };
  async function stage(kind: keyof typeof texts, mode: "paused" | "halted" | "running") {
    const { createPhaseIntake: create } = await import("../src/rooms/phase/server/intake");
    const { createFakePluginHost: host } = await import("@get-bb/plugin-sdk/testing");
    const { setJevForTests } = await import("@lane-pilot/jev");
    const { setRunPaused, setRunHalted } = await import("../src/rooms/runs/server/runs-halt");
    const { bb, harness } = host({ pluginId: "lane-pilot" });
    let request = { requestId: "creq_1", initiator: "user", input: [{ type: "text", text: texts[kind] }] } as Record<string, unknown>;
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: request }]);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const starts: string[] = [];
    const phases = { open: async () => { starts.push("phase"); return { id: "ph_1" }; }, tick: async () => { starts.push("tick"); return 0; }, list: () => [], status: () => ({ next: { text: "" } }) };
    setJevForTests({ enabled: () => true, judge: async () => ({ by: "jev", decision: { kind } }) } as never);
    const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: {} }) } as never, phases as never,
      { start: (input) => { starts.push(input.kind); return "wfrun_1"; }, status: () => "running", startProcess: async () => { starts.push("architect"); return "thr_arch"; } });
    if (mode === "paused") await setRunPaused(bb.storage.kv as never, "run1", true);
    if (mode === "halted") await setRunHalted(bb.storage.kv as never, "run1", true);
    return { intake, starts, bb, resume: async () => { await setRunPaused(bb.storage.kv as never, "run1", false); await setRunHalted(bb.storage.kv as never, "run1", false); request = { requestId: "creq_2", initiator: "user", input: [{ type: "text", text: texts[kind] }] }; }, done: () => setJevForTests(null) };
  }
  for (const mode of ["paused", "halted"] as const) {
    for (const kind of ["heavy", "small", "batch", "process"] as const) {
      it(`${kind} while the run is ${mode}: nothing starts, and a new request after resume does`, async () => {
        const w = await stage(kind, mode);
        try {
          expect(await w.intake.take("thr_pm")).toMatchObject({ kind });
          expect(w.starts).toEqual([]);
          await w.resume();
          expect(await w.intake.take("thr_pm")).toMatchObject({ requestId: "creq_2", kind });
          expect(w.starts.length).toBeGreaterThan(0);
        } finally { w.done(); }
      });
    }
  }
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
  it("an unsure judgment starts nothing: a remark it cannot place is a reply, not a small job", async () => {
    const { intakeJudgment } = await import("../src/rooms/phase/intake");
    const unsure = intakeJudgment.decide({ weight: { type: "choice", probabilities: { small: 0.4, reply: 0.35, question: 0.25 } } } as never, { min_p: 0.55 }, { text: "а меня зачем спрашиваешь?" });
    expect(unsure.decision).toEqual({ kind: "reply" });
    expect(JSON.stringify(intakeJudgment.questions({ text: "x" }))).toMatch(/complaint or feedback on how the work goes/);
  });
});

describe("a hand-over from a scheduled agent is one start per key (RECHECK-341 F7)", () => {
  const hand = (intake: ReturnType<typeof world>["intake"], text: string, key: string) => intake.handOver({ projectId: "projA", pmThreadId: PM, runId: "run1", text, key, origin: "Work found by the scheduled agent" });

  it("a late replay after the phase finished returns the same phase and opens no second one, also after a reload", async () => {
    const { intake, reloaded, opened } = world();
    expect(await hand(intake, goal, "schedule:run-a")).toMatchObject({ started: true, via: "phase", id: "ph_1" });
    opened[0]!.state = "closed";
    expect(await hand(intake, goal, "schedule:run-a")).toMatchObject({ started: true, via: "phase", id: "ph_1" });
    expect(await hand(reloaded(), goal, "schedule:run-a")).toMatchObject({ started: true, via: "phase", id: "ph_1" });
    expect(opened).toHaveLength(1);
    // Another key is a new piece of work and opens its own phase as before.
    expect(await hand(intake, goal, "schedule:run-b")).toMatchObject({ started: true, via: "phase", id: "ph_2" });
  });

  it("a replay while the phase is alive returns its id instead of a refusal, and a replay racing the first call opens one phase", async () => {
    const { intake, reloaded, opened } = world();
    expect(await hand(intake, goal, "schedule:run-a")).toMatchObject({ started: true, id: "ph_1" });
    expect(await hand(reloaded(), goal, "schedule:run-a")).toMatchObject({ started: true, via: "phase", id: "ph_1" });
    // A different key while the phase is live is still refused: it is not the same hand-over.
    expect(await hand(intake, goal, "schedule:run-b")).toMatchObject({ started: false, reason: expect.stringContaining("already live") });
    const racing = world();
    const both = await Promise.all([hand(racing.intake, goal, "schedule:run-c"), hand(racing.intake, goal, "schedule:run-c")]);
    expect(both.map((row) => (row.started ? row.id : null))).toEqual(["ph_1", "ph_1"]);
    expect(racing.opened).toHaveLength(1);
    expect(opened).toHaveLength(1);
  });

  it("the small and batch roads start their graph once per key", async () => {
    const started: Array<{ requestId: string; kind: string; path?: { size: string; risk: string } }> = [];
    const train: IntakeTrain = { start: (input) => { started.push({ requestId: input.requestId, kind: input.kind, path: input.path }); return `wfrun_${started.length}`; }, status: () => "succeeded" };
    const { intake, reloaded } = world({ train });
    expect(await hand(intake, "поправь опечатку в футере", "schedule:run-a")).toMatchObject({ started: true, via: "issue-quick", id: "wfrun_1" });
    expect(await hand(reloaded(), "поправь опечатку в футере", "schedule:run-a")).toMatchObject({ started: true, via: "issue-quick", id: "wfrun_1" });
    expect(started).toEqual([expect.objectContaining({ kind: "small", path: { size: "tiny", risk: "low" } })]);
    expect(await hand(intake, "поправь опечатку в хедере", "schedule:run-b")).toMatchObject({ started: true, id: "wfrun_2" });
  });
});
