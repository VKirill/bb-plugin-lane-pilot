import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import { createPhaseDriver } from "./phase-driver";
import { sha256Hex } from "@lane-pilot/kit";
import { contextSignature, isPlanWordGap, nextAction, planGate, planSignature, type PhaseRecord, type PlanItem } from "../src/rooms/phase/logic";
import { MACHINE_ANSWERER } from "../src/rooms/phase/server/driver-steps";
import { listParts, savePhase } from "../src/rooms/phase/store";
import { createRun, openDatabase } from "../src/rooms/plugin-db";
import { saveProjectSetting } from "../src/rooms/storage";

// Default-path audit 2026-11-14 §5.4: a phase decided its owner word once, at opening, from the title and goal, and every turn read that one
// flag. On owner.words=sensitive (the owner's rule: no task waits for a person except money, database migrations and production deploys)
// a neutral goal whose plan adds a migration asked nothing, and a goal that names a payment asked at every turn. Each turn now decides from
// its own evidence (src/rooms/phase/logic/words-policy.ts) and the decisions are kept in record.wordTurns.

const before = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
afterEach(() => { if (before === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = before; });

const piece = (id: string, wave: number, owns: string[], extra: Record<string, unknown> = {}): PlanItem => ({
  id, title: id, wave, promise: { given: "the repository", when: "the piece lands", then: `${id} is done` },
  task: { id, title: `Piece ${id}`, objective: `do ${id}`, kind: "code", owns_paths: owns, verification: [{ command: `npm test -- ${id}` }], acceptance: [`${id} works`], ...extra } as never,
});

async function world(words: string, input: { title?: string; goal?: string; settingRow?: boolean } = {}) {
  // The row is the project's own setting (the screen writes it); the env default is the suite's and must not decide here.
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = "off";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  if (input.settingRow !== false) saveProjectSetting(db, "projA", "owner.words", words);
  const services = { runBudgets: { get: () => undefined }, readWriterWorkspaceFile: async ({ path }: { path: string }) => ({ sha256: sha256Hex(path), sizeBytes: 120, content: `# ${path}` }) };
  const { phases } = createPhaseDriver(createCore(bb, db), services as never);
  const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: input.title ?? "Sums", goal: input.goal ?? "sums skip empty cells" });
  return { db, phases, id: opened.id, setWords: (value: string) => saveProjectSetting(db, "projA", "owner.words", value) };
}

const card = { docs: [".agents/phases/CONTEXT.md"], risks: { value: "users miss totals", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["no new screens"] };
const shape = { objective: "the goal", premortem: ["r1", "r2", "r3"] };

describe("each turn of a phase decides the owner's word from its own evidence (owner.words)", () => {
  it("[sma:p2_row_awaits] sensitive, a neutral goal, a plan that writes migrations/: the planning and issue turns ask, naming the class", async () => {
    const { phases, id } = await world("sensitive");
    const signed = await phases.context({ phaseId: id, ...card });
    // The neutral goal's context asks nothing: the phase is at planning without a word.
    expect(signed.stage).toBe("planning");
    expect(signed.record.wordTurns?.context).toMatchObject({ asks: false, classes: [] });
    const planned = phases.plan({ phaseId: id, items: [piece("schema", 1, ["migrations/0001_totals.sql"]), piece("ui", 2, ["src/sums.ts"])], ...shape, by: "pm" });
    const turns = planned.record.wordTurns!;
    expect(turns.planning).toMatchObject({ asks: true, classes: ["data"] });
    expect(turns.issue).toMatchObject({ asks: true, classes: ["data"] });
    // Each wave weighs its own pieces: the migration's wave asks, the code wave does not.
    expect(turns.waves?.["1"]).toMatchObject({ asks: true });
    expect(turns.waves?.["2"]).toMatchObject({ asks: false });
    const gate = planGate(planned.record);
    const word = gate.ok ? undefined : gate.why.find(isPlanWordGap);
    expect(word).toMatch(/the plan awaits the owner's word: it touches a database migration or data change \(schema: path:migrations\/0001_totals\.sql\)/);
    expect(word).not.toMatch(/owner\.words is on/);
  });

  it("[sma:p2_row_awaits] sensitive, a goal about a payment, a plan of docs only: no turn after the context asks, the plan waits for no word", async () => {
    const { phases, id } = await world("sensitive", { title: "Оплата", goal: "the README explains how the payment flow works" });
    // The goal names a payment: the context turn is in the money class and asks...
    expect(phases.status(id).phase.record.wordTurns?.context).toMatchObject({ asks: true, classes: ["money"] });
    const signed = await phases.context({ phaseId: id, ...card });
    expect(signed.stage).toBe("discussion");
    await phases.word({ phaseId: id, turn: "context", decision: "yes", text: "да", by: "owner via screen" });
    // ...but the plan is docs only: planning, issue and its wave do not.
    const planned = phases.plan({ phaseId: id, items: [piece("readme", 1, ["docs/payments.md"], { kind: "docs", objective: "describe the payment flow" })], ...shape, by: "pm" });
    expect(planned.record.wordTurns).toMatchObject({ planning: { asks: false }, issue: { asks: false }, waves: { "1": { asks: false } } });
    const gate = planGate(planned.record);
    expect(gate.ok ? [] : gate.why.filter(isPlanWordGap)).toEqual([]);
  });

  it("[sma:p1_confirm] on: every turn asks, whatever its evidence, as before", async () => {
    const { phases, id } = await world("on");
    const signed = await phases.context({ phaseId: id, ...card });
    expect(signed.stage).toBe("discussion");
    expect(nextAction(signed, new Map()).text).toMatch(/awaits the owner's word at context \(owner\.words is on\)/);
    await phases.word({ phaseId: id, turn: "context", decision: "yes", text: "да", by: "owner via screen" });
    const planned = phases.plan({ phaseId: id, items: [piece("readme", 1, ["docs/sums.md"], { kind: "docs" })], ...shape, by: "pm" });
    const turns = planned.record.wordTurns!;
    for (const turn of ["context", "planning", "design", "issue", "acceptance", "uat", "lesson"] as const) expect(turns[turn]?.asks, turn).toBe(true);
    expect(turns.waves?.["1"]?.asks).toBe(true);
    const gate = planGate(planned.record);
    expect(gate.ok ? [] : gate.why.filter(isPlanWordGap)).toEqual(["the plan awaits the owner's word: owner.words is on"]);
  });

  it("[sma:p2_row_awaits] an old record with ownerWords=true on sensitive is recomputed on its next step: the plan wait is lifted and the plan admitted", async () => {
    const { db, phases, id } = await world("sensitive");
    const docs = [{ path: "docs/CONTEXT.md", sha256: "a".repeat(64), bytes: 120 }];
    const context = { docs, sha: contextSignature(docs), signedAt: 1, risks: { value: "v", usability: "none", feasibility: "none", viability: "none" } };
    const items = [piece("a", 1, ["src/sums.ts"])];
    // ph_f16b2b8b06's shape: opened before 0.1.560 with the one flag, a plan the critic approved, only the owner's planning word missing.
    const legacy: PhaseRecord = { ownerWords: true, context, plan: { items, contextSha: context.sha, sha: planSignature(items, context.sha), ...shape, submittedAt: 1,
      critique: { decision: "approve", by: "plan-critic", independence: { ok: true, why: "checker thr_c started after planner thr_p and had the last word" } } } };
    savePhase(db, id, { stage: "planning", record: legacy, at: 2 });
    const held = planGate(phases.status(id).phase.record);
    expect(held.ok ? [] : held.why.filter(isPlanWordGap)).toEqual(["the plan awaits the owner's word: owner.words was on when the phase opened"]);
    await phases.tick();
    const after = phases.status(id).phase;
    expect(after.record.wordTurns?.planning).toMatchObject({ asks: false });
    expect(after.record.ownerWords).toBe(false);
    expect(after.record.plan?.admittedSha).toBe(after.record.plan?.sha);
    expect(["design", "execution"]).toContain(after.stage);
    // The book says why the phase stopped waiting.
    expect(listParts(db, id).map((part) => part.text).join("\n")).toMatch(/owner\.words sensitive: the owner's word is asked at context(, \w+)* \(was context, planning, design, issue, acceptance, uat, lesson\)|owner\.words sensitive: the owner's word is asked at none \(was/);
  });

  // A grill-plan run of `planSha` that ended open with one challenge, made after the plan was submitted.
  const grilled = (db: ReturnType<typeof openDatabase>, runId: string, planSha: string, at: number) =>
    db.prepare(`INSERT INTO lane_pilot_wf_run(id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, link_run_id, status, inputs_json, output_json, created_at, updated_at)
      VALUES(?, 'grill-plan', 1, 'x', '{}', 'projA', 'run1', 'succeeded', ?, ?, ?, ?)`).run(runId, JSON.stringify({ plan_sha: planSha }), JSON.stringify({ status: "open", open: ["what if the cell holds text?"] }), at, at);
  // The critic approved with its independence proved: only the grill (and the owner's word, where asked) can hold admission.
  const approve = (db: ReturnType<typeof openDatabase>, phases: Awaited<ReturnType<typeof world>>["phases"], id: string, extra: Partial<PhaseRecord> = {}) => {
    const record = phases.status(id).phase.record;
    savePhase(db, id, { record: { ...record, auto: undefined, plan: { ...record.plan!, critique: { decision: "approve", by: "plan-critic", independence: { ok: true, why: "proved" } } }, ...extra }, at: Date.now() });
  };

  it("[sma:k_v_grill] sensitive, a plan outside the three classes grilled open: the machine plans once more instead of waiting, then admits over what stays open", async () => {
    const { db, phases, id } = await world("sensitive");
    await phases.context({ phaseId: id, ...card });
    const planned = phases.plan({ phaseId: id, items: [piece("a", 1, ["src/sums.ts"])], ...shape, by: "pm" });
    grilled(db, "wf_grill_1", planned.record.plan!.sha, planned.record.plan!.submittedAt! + 1);
    approve(db, phases, id);
    await phases.tick();
    const first = phases.status(id).phase;
    expect(first.stage).toBe("planning");
    expect(first.record.plan?.admittedSha).toBeUndefined();
    expect(first.record.replan?.gaps).toMatch(/what if the cell holds text\?/);
    expect(first.record.grillReplan?.planSha).toBe(planned.record.plan!.sha);
    expect(listParts(db, id).map((part) => part.kind)).toContain("grill_replan");
    // The replan's plan, grilled open again: admitted, the open challenge kept in the book.
    const replanned = phases.plan({ phaseId: id, items: [piece("a", 1, ["src/sums.ts"], { acceptance: ["a works", "a text cell is skipped"] })], ...shape, by: "lp.plan" });
    grilled(db, "wf_grill_2", replanned.record.plan!.sha, replanned.record.plan!.submittedAt! + 1);
    approve(db, phases, id);
    await phases.tick();
    const second = phases.status(id).phase;
    expect(second.record.plan?.admittedSha).toBe(replanned.record.plan!.sha);
    expect(second.stage).not.toBe("planning");
    expect(listParts(db, id).find((part) => part.kind === "grill_passed")?.text).toMatch(/what if the cell holds text\?/);
  });

  it("[sma:k_v_grill] on: an open grill still waits for the owner's word, as before", async () => {
    const { db, phases, id } = await world("on");
    await phases.context({ phaseId: id, ...card });
    await phases.word({ phaseId: id, turn: "context", decision: "yes", text: "да", by: "owner via screen" });
    const planned = phases.plan({ phaseId: id, items: [piece("a", 1, ["src/sums.ts"])], ...shape, by: "pm" });
    grilled(db, "wf_grill_1", planned.record.plan!.sha, Date.now() + 60_000);
    approve(db, phases, id);
    await phases.tick();
    expect(phases.status(id).phase.record.plan?.admittedSha).toBeUndefined();
    // The owner's yes given before the grill does not lift it: the admission is refused with the open challenge, nothing is replanned.
    await expect(phases.word({ phaseId: id, turn: "planning", decision: "yes", text: "да", by: "owner via screen" }))
      .rejects.toMatchObject({ why: expect.arrayContaining([expect.stringContaining("open grill question: what if the cell holds text?")]) });
    expect(phases.status(id).phase.record.grillReplan).toBeUndefined();
    expect(phases.status(id).phase.record.plan?.admittedSha).toBeUndefined();
  });
});

describe("a blocking stage question on sensitive outside the three classes", () => {
  it("is answered by Lane Pilot after the PM's five minutes, and the gate goes on", async () => {
    const { db, phases, id } = await world("sensitive");
    phases.question({ phaseId: id, text: "Which tag syntax?", blocking: true });
    const asked = phases.status(id).phase;
    // A PM at work gets five minutes first: a fresh question is not answered by the machine.
    await phases.tick();
    expect(phases.status(id).phase.record.questions?.[0]?.answer).toBeUndefined();
    savePhase(db, id, { record: { ...asked.record, questions: asked.record.questions!.map((q) => ({ ...q, askedAt: q.askedAt - 6 * 60_000 })) }, at: Date.now() });
    await phases.tick();
    const answered = phases.status(id).phase.record.questions?.[0];
    expect(answered).toMatchObject({ answeredBy: MACHINE_ANSWERER });
    expect(answered?.answer).toMatch(/take the narrower reading/);
    expect(listParts(db, id).some((part) => part.kind === "answer" && part.text.includes(MACHINE_ANSWERER))).toBe(true);
  });

  it("waits for the PM (who may ask the owner) when the stage's turn is in a class, and on on", async () => {
    for (const [words, goal] of [["sensitive", "migrate the database schema: add a totals table"], ["on", "sums skip empty cells"]] as const) {
      const { db, phases, id } = await world(words, { goal });
      phases.question({ phaseId: id, text: "Which tag syntax?", blocking: true });
      const asked = phases.status(id).phase;
      savePhase(db, id, { record: { ...asked.record, questions: asked.record.questions!.map((q) => ({ ...q, askedAt: q.askedAt - 6 * 60_000 })) }, at: Date.now() });
      await phases.tick();
      expect(phases.status(id).phase.record.questions?.[0]?.answer, words).toBeUndefined();
    }
  });
});

describe("a change of owner.words reaches a phase in flight", () => {
  it("on → sensitive lifts a context that waited only for the owner's signature: the next step moves it to planning", async () => {
    const { phases, id, setWords } = await world("on");
    const signed = await phases.context({ phaseId: id, ...card });
    expect(signed.stage).toBe("discussion");
    setWords("sensitive");
    await phases.tick();
    const after = phases.status(id).phase;
    expect(after.stage).toBe("planning");
    expect(after.record.wordTurns).toMatchObject({ mode: "sensitive", context: { asks: false } });
  });
});
