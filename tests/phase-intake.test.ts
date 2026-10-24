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
      const phase = { id: `ph_${opened.length + 1}`, projectId: input.projectId, pmThreadId: input.pmThreadId, runId: "run1", title: input.title, goal: input.goal,
        stage: "discussion", state: "active", record: {}, edition: 1, createdAt: 1, updatedAt: 1 } as unknown as Phase;
      opened.push(phase);
      return phase;
    },
    tick: async () => 0,
    list: (filter) => opened.filter((phase) => (!filter.pmThreadId || phase.pmThreadId === filter.pmThreadId) && (!filter.live || phase.state !== "closed")),
    status: () => ({ next: { text: "write the discussion files and report them with context" } }),
  };
  const intake = createPhaseIntake({ bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: options.settings ?? {} }) } as never, phases);
  return { intake, opened, say: (text: string, id: string, initiator = "user") => { request = { requestId: id, initiator, input: [{ type: "text", text }] }; } };
}

describe("phase intake rules", () => {
  it("settles a consent and a short message in code, and leaves a long one to the judgment", () => {
    expect(intakeByRules("да")).toEqual({ kind: "consent", confident: true });
    expect(intakeByRules("поправь опечатку в футере")).toEqual({ kind: "small", confident: true });
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
  it("a paused or closed phase lets the PM dispatch", async () => {
    const { intake, opened } = world();
    await intake.take(PM);
    (opened[0] as { state: string }).state = "paused";
    expect(await intake.dispatchRefusal(PM)).toBeNull();
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
