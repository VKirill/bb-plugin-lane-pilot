import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { HEAVY_LENGTH, intakeByRules, intakeRunGoals, isMachineMessage } from "../src/rooms/phase/intake";
import { createPhaseIntake, type IntakePhases, type IntakeTrain } from "../src/rooms/phase/server/intake";
import type { Phase } from "../src/rooms/phase/logic";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../src/rooms/plugin-db";
import { pmPrompt } from "../src/rooms/platform/server/pm-spawn";
import type { PrototypeConfig } from "../src/rooms/contracts";
import bootstrapEvents from "./fixtures/phase-intake-pm-bootstrap-2026-10-29.json";

const PM = "thr_pm";
const goal = `Нужно сделать раздел блога заново: авторы, категории, поиск, SEO-разметка каждой страницы, перенос старых статей и редиректы. ${"Подробности и требования к каждому экрану. ".repeat(20)}`;

function world(options: { settings?: Record<string, unknown>; role?: string; train?: IntakeTrain; request?: Record<string, unknown> } = {}) {
  let request = options.request ?? { requestId: "creq_1", initiator: "user", input: [{ type: "text", text: goal }] } as Record<string, unknown>;
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: options.role ?? "pm", lanePilotRunId: "run1" }));
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (args: unknown) => { sent.push(JSON.stringify(args)); return {}; });
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
    tick: async () => ({ moved: 0, idle: null }),
    list: (filter) => opened.filter((phase) => (!filter.pmThreadId || phase.pmThreadId === filter.pmThreadId) && (!filter.live || !["closed", "stopped"].includes(phase.state))),
    status: () => ({ next: { text: "write the discussion files and report them with context" } }),
  };
  // The phase road: these tests are about the phase machine; the graph road has its own test below.
  const deps = { bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: { "phase.rails": "on", "phase.road": "phase", ...options.settings } }) } as never;
  const intake = createPhaseIntake(deps, phases, options.train);
  /** The plugin after a reload: a new intake over the same store and the same phases. */
  const reloaded = () => createPhaseIntake(deps, phases, options.train);
  return { intake, reloaded, opened, db, sent, say: (text: string, id: string, initiator = "user") => { request = { requestId: id, initiator, input: [{ type: "text", text }] }; } };
}

describe("phase intake rules", () => {
  it("settles a consent and a short message in code, and reads a long one as heavy", () => {
    expect(intakeByRules("да")).toEqual({ kind: "consent", confident: true });
    expect(intakeByRules("поправь опечатку в футере")).toEqual({ kind: "small", confident: false });
    expect(intakeByRules("почему не грузится каталог?")).toEqual({ kind: "question", confident: true });
    expect(intakeByRules("x".repeat(HEAVY_LENGTH + 1))).toEqual({ kind: "heavy", confident: false });
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

describe("rails off by default: the PM reads the owner's message itself", () => {
  it("starts nothing and refuses no dispatch when the project did not turn phase.rails on", async () => {
    const started: string[] = [];
    const train: IntakeTrain = { start: (input) => { started.push(input.text); return "wfrun_x"; }, status: () => "running" };
    const { intake, opened } = world({ settings: { "phase.rails": undefined }, train });
    expect(await intake.take(PM)).toBeNull();
    expect(started).toEqual([]);
    expect(opened).toEqual([]);
    expect(await intake.dispatchRefusal(PM)).toBeNull();
  });
});

describe("the graph road (phase.road graph, the default)", () => {
  it("runs a heavy owner goal as the full-lifecycle graph, opens no phase, and the PM does not dispatch it by hand", async () => {
    const started: Array<{ kind: string; text: string }> = [];
    const train: IntakeTrain = { start: (input) => { started.push(input); return "wfrun_life"; }, status: () => "running" };
    const { intake, opened } = world({ settings: { "phase.road": "graph" }, train });
    expect(await intake.take(PM)).toMatchObject({ kind: "heavy", phaseId: null, wfRunId: "wfrun_life" });
    expect(started).toEqual([expect.objectContaining({ kind: "heavy" })]);
    expect(opened).toEqual([]);
    expect(await intake.dispatchRefusal(PM)).toMatch(/went down a graph[\s\S]*wfrun_life[\s\S]*owner's acceptance/);
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
    const phases = { open: async () => { throw new Error("no phase"); }, tick: async () => ({ moved: 0, idle: null }), list: () => [], status: () => ({ next: { text: "" } }) };
    const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: { "phase.rails": "on" } }) } as never, phases as never,
      { start: (input) => { started.push(input.text); return "wfrun_1"; }, status: () => "running" });
    (intake as { classify: unknown }).classify = undefined;
    // No Jev here: the length rule alone does not start a build.
    expect(await intake.take("thr_pm")).toMatchObject({ kind: "small", by: "rules" });
    expect(started).toEqual([]);
    expect(await intake.dispatchRefusal("thr_pm")).toBeNull();
    // Read with the judgment's word, the request is the graph's: dispatching it by hand is refused while the run works.
    await bb.storage.kv.set("phase-intake:thr_pm", { requestId: "creq_s", kind: "small", by: "jev", phaseId: null, at: 1, wfRunId: "wfrun_1" });
    expect(await intake.dispatchRefusal("thr_pm")).toMatch(/went down a graph[\s\S]*wfrun_1/);
    // Read with the judgment's word, the request is the graph's: dispatching it by hand is refused while the run works.
    await bb.storage.kv.set("phase-intake:thr_pm", { requestId: "creq_s", kind: "small", by: "jev", phaseId: null, at: 1, wfRunId: "wfrun_1" });
    expect(await intake.dispatchRefusal("thr_pm")).toMatch(/went down a graph[\s\S]*wfrun_1/);
  });
});

describe("the service answers", () => {
  it("a cancel_requested attempt still counts as open work (OPEN_ATTEMPT_STATES, not the old four-state list)", async () => {
    const { intake, db, sent, say } = world();
    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: { title: "Fix the hero" } });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
    transitionAttempt(db, "a1", "cancel_requested", { reason: "owner asked to stop" });
    say("что сейчас идёт?", "creq_svc");
    expect(await intake.take(PM)).toMatchObject({ kind: "service", by: "rules" });
    expect(sent.some((s) => s.includes("Fix the hero"))).toBe(true);
  });
});

describe("one stop check guards every machine start in the intake", () => {
  const texts = { heavy: goal, small: "поправь цвет кнопки", batch: "исправь список: 1) футер 2) шапка 3) меню", process: "сделай процесс: каждый день собирай отчёт и отправляй" };
  async function stage(kind: keyof typeof texts, mode: "paused" | "halted" | "running") {
    const { createPhaseIntake: create } = await import("../src/rooms/phase/server/intake");
    const { createFakePluginHost: host } = await import("@get-bb/plugin-sdk/testing");
    const { setRunPaused, setRunHalted } = await import("../src/rooms/runs/server/runs-halt");
    const { bb, harness } = host({ pluginId: "lane-pilot" });
    let request = { requestId: "creq_1", initiator: "user", input: [{ type: "text", text: texts[kind] }] } as Record<string, unknown>;
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: request }]);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const starts: string[] = [];
    const phases = { open: async () => { starts.push("phase"); return { id: "ph_1" }; }, tick: async () => { starts.push("tick"); return 0; }, list: () => [], status: () => ({ next: { text: "" } }) };
    const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: { "phase.rails": "on" } }) } as never, phases as never,
      { start: (input) => { starts.push(input.kind); return "wfrun_1"; }, status: () => "running", startProcess: async () => { starts.push("architect"); return "thr_arch"; } });
    if (mode === "paused") await setRunPaused(bb.storage.kv as never, "run1", true);
    if (mode === "halted") await setRunHalted(bb.storage.kv as never, "run1", true);
    return { intake, starts, bb, resume: async () => { await setRunPaused(bb.storage.kv as never, "run1", false); await setRunHalted(bb.storage.kv as never, "run1", false); request = { requestId: "creq_2", initiator: "user", input: [{ type: "text", text: texts[kind] }] }; }, done: () => undefined };
  }
  for (const mode of ["paused", "halted"] as const) {
    for (const kind of ["heavy"] as const) {
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
    const phases = { open: async () => { throw new Error("no phase"); }, tick: async () => ({ moved: 0, idle: null }), list: () => [], status: () => ({ next: { text: "" } }) };
    const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: { "phase.rails": "on" } }) } as never, phases as never,
      { start: () => "wfrun_1", status: () => "running" });
    await bb.storage.kv.set("phase-intake:thr_pm", { requestId: "creq_p", kind: "small", by: "jev", phaseId: null, at: 1, wfRunId: "wfrun_1" });
    expect(await intake.launchRefusal("thr_pm")).toMatch(/went down a graph/);
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

describe("a hand-over is approved work, whatever it reads like (lead «да», 2026-11-03)", () => {
  it("a diagnosis that reads as a question starts the small graph instead of «hand-over blocked»", async () => {
    const started: string[] = [];
    const train: IntakeTrain = { start: (input) => { started.push(input.kind); return `wfrun_${started.length}`; }, status: () => "succeeded" };
    const { intake } = world({ train });
    const text = "Найти причину, по которой три задачи подряд не прошли проверку учётных записей?";
    expect(await intake.handOver({ projectId: "projA", pmThreadId: PM, runId: "run1", text, key: "lead:road_x", origin: "Accepted by the owner" }))
      .toMatchObject({ started: true, via: "issue-quick" });
    expect(started).toEqual(["small"]);
  });

  it("decided work that reads large goes down issue-full, titled by the work, not by its origin (hub, 2026-11-06)", async () => {
    const started: Array<{ kind: string; text: string }> = [];
    const train: IntakeTrain = { start: (input) => { started.push({ kind: input.kind, text: input.text }); return `wfrun_${started.length}`; }, status: () => "succeeded" };
    const { intake } = world({ train });
    const text = "Навык для: прогоны фото-инструмента. Перепиши порядок действий помощника в один навык.";
    expect(await intake.handOver({ projectId: "projA", pmThreadId: PM, runId: "run1", text, key: "lead:road_y", origin: "Opened by the lead" }))
      .toMatchObject({ started: true, via: "issue-full" });
    expect(started[0]!.kind).toBe("full");
    expect(started[0]!.text.startsWith("Навык для: прогоны фото-инструмента")).toBe(true);
  });

  it("decided heavy work in a project without phase rails goes down issue-full instead of «phase rails are off» (BB-сервис, 2026-11-10)", async () => {
    const started: string[] = [];
    const train: IntakeTrain = { start: (input) => { started.push(input.kind); return `wfrun_${started.length}`; }, status: () => "succeeded" };
    const { intake, opened } = world({ train, settings: { "phase.rails": "off" } });
    expect(await intake.handOver({ projectId: "projA", pmThreadId: PM, runId: "run1", text: goal, key: "lead:road_z", origin: "Accepted by the owner" }))
      .toMatchObject({ started: true, via: "issue-full", id: "wfrun_1" });
    expect(started).toEqual(["full"]);
    expect(opened).toHaveLength(0);
    // Without the graph road there is still nowhere to go, and the refusal says why.
    const bare = world({ settings: { "phase.rails": "off" } });
    expect(await bare.intake.handOver({ projectId: "projA", pmThreadId: PM, runId: "run1", text: goal, key: "lead:road_z", origin: "Accepted by the owner" }))
      .toMatchObject({ started: false, reason: "phase rails are off" });
  });
});

describe("the rules read a request for suggestions as a question and a status line as a service request", () => {
  it("a request for suggestions that ends with a question mark is a question, not a build (ph_82dfc9db78)", () => {
    const asked = "Есть предложения как можно улучшить дизайн и архитектуру раздела на телефонах?";
    expect(intakeByRules(asked)).toEqual({ kind: "question", confident: true });
  });
  it("a one-line status, current, results or cancel request is a service request; a long message that mentions one is not", () => {
    expect(intakeByRules("статус")).toEqual({ kind: "service", confident: true, service: "status" });
    expect(intakeByRules("что сейчас идёт?")).toMatchObject({ kind: "service", service: "current" });
    expect(intakeByRules("покажи результаты")).toMatchObject({ kind: "service", service: "results" });
    expect(intakeByRules("отмени задачу LP-T3")).toMatchObject({ kind: "service", service: "cancel" });
    expect(intakeByRules("статус страницы заказов нужно переделать целиком, добавить фильтры")).toMatchObject({ kind: "small" });
  });
});
