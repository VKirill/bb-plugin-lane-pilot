import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { HEAVY_LENGTH, intakeByRules, intakeRunGoals, isMachineMessage } from "../src/rooms/workflow";
import { createPhaseIntake, type IntakeTrain } from "../src/rooms/workflow/server";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../src/rooms/plugin-db";
import { pmPrompt } from "../src/rooms/platform/server/services/pm-spawn";
import type { PrototypeConfig } from "../src/rooms/contracts";
import bootstrapEvents from "./fixtures/phase-intake-pm-bootstrap-2026-10-29.json";

const PM = "thr_pm";

const goal = `Нужно сделать раздел блога заново: авторы, категории, поиск, SEO-разметка каждой страницы, перенос старых статей и редиректы. ${"Подробности и требования к каждому экрану. ".repeat(20)}`;

function world(options: { settings?: Record<string, unknown>; role?: string; train?: IntakeTrain | null; request?: Record<string, unknown> } = {}) {
  let request = options.request ?? { requestId: "creq_1", initiator: "user", input: [{ type: "text", text: goal }] } as Record<string, unknown>;
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: options.role ?? "pm", lanePilotRunId: "run1" }));
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (args: unknown) => { sent.push(JSON.stringify(args)); return {}; });
  harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: request }]);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  // phase.road is retired: a heavy request always takes the full-lifecycle graph; `train: null` simulates its absence.
  const deps = { bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: { "phase.rails": "on", ...options.settings } }) } as never;
  const graphStarts: Array<{ kind: string; text: string }> = [];
  const train = options.train === null ? undefined : options.train ?? { start: (input: { kind: string; text: string }) => { graphStarts.push(input); return `wfrun_${graphStarts.length}`; }, status: () => "running" } as IntakeTrain;
  const intake = createPhaseIntake(deps, train);
  /** The plugin after a reload: a new intake over the same store. */
  const reloaded = () => createPhaseIntake(deps, train);
  return { intake, reloaded, db, sent, graphStarts, say: (text: string, id: string, initiator = "user") => { request = { requestId: id, initiator, input: [{ type: "text", text }] }; } };
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
    // The owner's own words that merely start with the plugin's name stay owner messages.
    expect(isMachineMessage("Lane Pilot, исправь футер на главной")).toBe(false);
    expect(isMachineMessage("[Lane Pilot service] Тяжёлая задача не запущена")).toBe(true);
    // A workflow run's end notice started the next issue-quick, whose notice started the next (live 2026-10-26, Vampirism Fire).
    expect(isMachineMessage("Workflow run wfrun_a018031b894f42758ee7767e61b7debc of issue-quick is succeeded.\nNext: call lane_pilot_workflow_status")).toBe(true);
    expect(isMachineMessage("Workflow run in the docs is broken, fix it")).toBe(false);
  });
});

describe("rails off by default: the PM reads the owner's message itself", () => {
  it("starts nothing and refuses no dispatch when the project did not turn phase.rails on", async () => {
    const started: string[] = [];
    const train: IntakeTrain = { start: (input) => { started.push(input.text); return "wfrun_x"; }, status: () => "running" };
    const { intake } = world({ settings: { "phase.rails": undefined }, train });
    expect(await intake.take(PM)).toBeNull();
    expect(started).toEqual([]);
    expect(await intake.dispatchRefusal(PM)).toBeNull();
  });
});

describe("the graph road (phase.road graph, the default)", () => {
  it("runs a heavy owner goal as the full-lifecycle graph, opens no phase, and the PM does not dispatch it by hand", async () => {
    const started: Array<{ kind: string; text: string }> = [];
    const train: IntakeTrain = { start: (input) => { started.push(input); return "wfrun_life"; }, status: () => "running" };
    const { intake } = world({ settings: { "phase.road": "graph" }, train });
    expect(await intake.take(PM)).toMatchObject({ kind: "heavy", phaseId: null, wfRunId: "wfrun_life" });
    expect(started).toEqual([expect.objectContaining({ kind: "heavy" })]);
    expect(await intake.dispatchRefusal(PM)).toMatch(/went down a graph[\s\S]*wfrun_life[\s\S]*owner's acceptance/);
  });
});

describe("rails by default", () => {
  it.each(bootstrapEvents)("does not analyze the live PM bootstrap $threadId as an owner's goal", async (event) => {
    const started: string[] = [];
    const { intake, say } = world({ request: event.data,
      train: { start: (input) => { started.push(input.text); return "wfrun_1"; }, status: () => "running" } });
    expect(await intake.take(PM)).toBeNull();
    expect(started).toHaveLength(0);
    expect(await intake.dispatchRefusal(PM)).toBeNull();
    say(goal, "creq_real_owner");
    expect(await intake.take(PM)).toMatchObject({ kind: "heavy", wfRunId: "wfrun_1" });
  });
  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "leaves the PM activation instruction alone (managed=%s, native=%s)", async (managed, native) => {
      const text = pmPrompt("lprun_bootstrap", { writerWorkspacePath: "/home/ubuntu/lp-drill-sandbox" } as PrototypeConfig, managed, native);
      const { intake } = world({ request: { source: "spawn", requestId: "creq_bootstrap", initiator: "user", input: [{ type: "text", text }] } });
      expect(await intake.take(PM)).toBeNull();
    });
  it("still reads a real owner's goal in the spawn of a native PM chat", async () => {
    const { intake } = world({ request: { source: "spawn", requestId: "creq_native", initiator: "user", input: [{ type: "text", text: goal }] } });
    expect(await intake.take(PM)).toMatchObject({ kind: "heavy", wfRunId: "wfrun_1" });
  });
  it("a heavy owner goal starts the full-lifecycle graph once, opens no phase, and the PM may not dispatch it by hand", async () => {
    const { intake, graphStarts } = world();
    const record = await intake.take(PM);
    expect(record).toMatchObject({ kind: "heavy", wfRunId: "wfrun_1" });
    expect(graphStarts).toEqual([expect.objectContaining({ kind: "heavy" })]);
    expect(await intake.take(PM)).toMatchObject({ wfRunId: "wfrun_1" });
    expect(graphStarts).toHaveLength(1);
    expect(await intake.dispatchRefusal(PM)).toMatch(/went down a graph[\s\S]*wfrun_1[\s\S]*owner's acceptance/);
  });
  it("a heavy owner goal with no graph train is explicitly unavailable, never a phase", async () => {
    const { intake, sent } = world({ train: null });
    expect(await intake.take(PM)).toMatchObject({ kind: "heavy", phaseId: null });
    expect(sent.some((line) => line.includes("[Lane Pilot service]") && line.includes("Тяжёлая задача не запущена"))).toBe(true);
  });
  it("a small request after the graph started is dispatched as before", async () => {
    const { intake, say } = world();
    await intake.take(PM);
    say("поправь опечатку в футере", "creq_2");
    expect(await intake.dispatchRefusal(PM)).toBeNull();
  });
  it("Lane Pilot's own notices and agents' messages do not change the owner's request", async () => {
    const { intake, say } = world();
    await intake.take(PM);
    say("Lane Pilot: results of your tasks", "creq_3");
    expect(await intake.dispatchRefusal(PM)).toMatch(/went down a graph/);
    say("поправь опечатку", "creq_4", "agent");
    expect(await intake.dispatchRefusal(PM)).toMatch(/went down a graph/);
  });
  it("phase.rails off, or a chat that is not a PM's, is left alone", async () => {
    const off = world({ settings: { "phase.rails": "off" } });
    expect(await off.intake.take(PM)).toBeNull();
    const writer = world({ role: "writer" });
    expect(await writer.intake.take(PM)).toBeNull();
  });
});

describe("the small-task graph", () => {
  it("is started by the machine on the judgment's word, and the PM does not dispatch that request by hand", async () => {
    const { createPhaseIntake: create } = await import("../src/rooms/workflow/server/services/intake");
    const { createFakePluginHost: host } = await import("@get-bb/plugin-sdk/testing");
    const { bb, harness } = host({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: { requestId: "creq_s", initiator: "user", input: [{ type: "text", text: "поправь опечатку в футере" }] } }]);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const started: string[] = [];
    const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: { "phase.rails": "on" } }) } as never,
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
    const { createPhaseIntake: create } = await import("../src/rooms/workflow/server/services/intake");
    const { createFakePluginHost: host } = await import("@get-bb/plugin-sdk/testing");
    const { setRunPaused, setRunHalted } = await import("../src/rooms/runs/server");
    const { bb, harness } = host({ pluginId: "lane-pilot" });
    let request = { requestId: "creq_1", initiator: "user", input: [{ type: "text", text: texts[kind] }] } as Record<string, unknown>;
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: request }]);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const starts: string[] = [];
    const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: { "phase.rails": "on" } }) } as never,
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
    const { createPhaseIntake: create } = await import("../src/rooms/workflow/server/services/intake");
    const { createFakePluginHost: host } = await import("@get-bb/plugin-sdk/testing");
    const { bb, harness } = host({ pluginId: "lane-pilot" });
    let architect = "running";
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    harness.sdk.stub("threads.events.list", async () => [{ type: "client/turn/requested", data: { requestId: "creq_p", initiator: "user", input: [{ type: "text", text: "x".repeat(300) }] } }]);
    harness.sdk.stub("threads.get", async () => ({ id: "thr_arch", status: architect }));
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const intake = create({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: { "phase.rails": "on" } }) } as never,
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
    expect(await intake.dispatchRefusal("thr_pm")).toMatch(/lane_pilot_workflow_draft/);
  });
});

describe("a hand-over from a scheduled agent is one start per key (RECHECK-341 F7)", () => {
  const hand = (intake: ReturnType<typeof world>["intake"], text: string, key: string) => intake.handOver({ projectId: "projA", pmThreadId: PM, runId: "run1", text, key, origin: "Work found by the scheduled agent" });

  it("a late replay after the graph finished returns the same run and starts no second one, also after a reload", async () => {
    const { intake, reloaded, graphStarts } = world();
    expect(await hand(intake, goal, "schedule:run-a")).toMatchObject({ started: true, via: "full-lifecycle", id: "wfrun_1" });
    expect(await hand(intake, goal, "schedule:run-a")).toMatchObject({ started: true, via: "full-lifecycle", id: "wfrun_1" });
    expect(await hand(reloaded(), goal, "schedule:run-a")).toMatchObject({ started: true, via: "full-lifecycle", id: "wfrun_1" });
    expect(graphStarts).toHaveLength(1);
    // Another key is a new piece of work and starts its own graph.
    expect(await hand(intake, goal, "schedule:run-b")).toMatchObject({ started: true, via: "full-lifecycle", id: "wfrun_2" });
  });
  it("a heavy hand-over without the graph train is explicitly unavailable, never a phase", async () => {
    const { intake } = world({ train: null });
    expect(await hand(intake, goal, "schedule:run-a")).toMatchObject({ started: false, kind: "heavy", reason: "the full-lifecycle graph is unavailable" });
  });

  it("a replay returns the same run and a replay racing the first call starts it once", async () => {
    const { intake, reloaded, graphStarts } = world();
    expect(await hand(intake, goal, "schedule:run-a")).toMatchObject({ started: true, via: "full-lifecycle", id: "wfrun_1" });
    expect(await hand(reloaded(), goal, "schedule:run-a")).toMatchObject({ started: true, via: "full-lifecycle", id: "wfrun_1" });
    const racing = world();
    const both = await Promise.all([hand(racing.intake, goal, "schedule:run-c"), hand(racing.intake, goal, "schedule:run-c")]);
    expect(both.map((row) => (row.started ? row.id : null))).toEqual(["wfrun_1", "wfrun_1"]);
    expect(racing.graphStarts).toHaveLength(1);
    expect(graphStarts).toHaveLength(1);
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
    const { intake } = world({ train, settings: { "phase.rails": "off" } });
    expect(await intake.handOver({ projectId: "projA", pmThreadId: PM, runId: "run1", text: goal, key: "lead:road_z", origin: "Accepted by the owner" }))
      .toMatchObject({ started: true, via: "issue-full", id: "wfrun_1" });
    expect(started).toEqual(["full"]);
    // Without the graph road there is still nowhere to go, and the refusal says why.
    const bare = world({ settings: { "phase.rails": "off" }, train: null });
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
