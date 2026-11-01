import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setJevForTests } from "@lane-pilot/jev";
import { examAll } from "../../src/rooms/lead/logic";
import { runLeadCli } from "../../src/rooms/lead/cli";
import { answerDecision, askDecision, examRows, getDecision, labelDecision, listDecisions, openDecision, predictDecision, ruleVerdict } from "../../src/rooms/lead/server/journal";
import { backtest } from "../../src/rooms/lead/server/backtest";
import { answerPhaseWord, answerTaskWord, askPhaseWord, askTaskWord, phaseDecisionId, wordDecisionId } from "../../src/rooms/lead/server/surfaces";
import { insertPhase, savePhase } from "../../src/rooms/phase/store";
import { createRun, createTask, openDatabase } from "../../src/rooms/storage/database";
import { recordTaskWord } from "../../src/rooms/tasks/words";

const world = () => { const { bb } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, db: openDatabase(bb) }; };
/** A Jev in shadow mode: the verdict is the fallback, the shadow decision is what the lead would have said. */
const shadowJev = (option: string | null, p = 0.9) => setJevForTests({ enabled: () => true, judge: async () => ({ by: "fallback", status: "shadow", decision: { option: null, p: 0 }, shadow: { decision: { option, p } } }) } as never);
const question = (id: string, extra: Record<string, unknown> = {}) => ({ id, surface: "words", class: "landing", risk: "low", projectId: "P", runId: "run1", situation: { task: "fix the tests" }, options: ["yes", "no"], ...extra });
afterEach(() => setJevForTests(null));

describe("the decision journal: open, predict before the answer, answer, judge", () => {
  it("records the shadow prediction and scores exact when the owner picks the same option", async () => {
    const { db } = world();
    shadowJev("yes");
    await askDecision(db, question("d1"), undefined, 1_000);
    const open = getDecision(db, "d1")!;
    expect(open).toMatchObject({ prediction_json: JSON.stringify({ option: "yes", p: 0.9 }), predicted_at: 1_000, predictor: "jev-shadow:lead.predict@1", answered_at: null, split: "exam" });
    const done = answerDecision(db, "d1", { option: "yes", text: "да" }, "pm", 2_000)!;
    expect(done).toMatchObject({ judge_verdict: "exact", judge_model: "rule", answered_by: "pm", answered_at: 2_000 });
    expect(JSON.parse(done.answer_json!)).toEqual({ option: "yes", text: "да" });
  });

  it("scores a miss on the other option, defers without a prediction, and never guesses an option the surface did not offer", async () => {
    const { db } = world();
    shadowJev("yes");
    await askDecision(db, question("miss"), undefined, 1);
    expect(answerDecision(db, "miss", { option: "no" }, "pm", 2)!.judge_verdict).toBe("miss");
    setJevForTests(null);
    await askDecision(db, question("cold"), undefined, 1);
    expect(getDecision(db, "cold")).toMatchObject({ prediction_json: JSON.stringify({ option: null, p: 0 }), predictor: "none" });
    expect(answerDecision(db, "cold", { option: "yes" }, "pm", 2)!.judge_verdict).toBe("deferred");
    shadowJev("maybe");
    await askDecision(db, question("stray"), undefined, 1);
    expect(JSON.parse(getDecision(db, "stray")!.prediction_json!)).toEqual({ option: null, p: 0.9 });
    expect(ruleVerdict({ option: "yes", p: 0.7 }, { option: "yes" })).toBe("exact");
  });

  it("opens once, predicts once, keeps the first answer, and labels only an answered row", async () => {
    const { db } = world();
    shadowJev("no");
    expect(openDecision(db, question("once"), 5).created).toBe(true);
    expect(openDecision(db, question("once", { risk: "high" }), 6).created).toBe(false);
    await predictDecision(db, "once", undefined, 7);
    shadowJev("yes");
    expect(await predictDecision(db, "once", undefined, 8)).toBeNull();
    expect(labelDecision(db, "once", "exact", 9)).toBe(false);
    answerDecision(db, "once", { option: "no" }, "pm", 10);
    answerDecision(db, "once", { option: "yes" }, "screen", 11);
    expect(getDecision(db, "once")).toMatchObject({ risk: "low", answered_by: "pm", judge_verdict: "exact", predicted_at: 7 });
    expect(labelDecision(db, "once", "partial", 12)).toBe(true);
    expect(getDecision(db, "once")).toMatchObject({ owner_label: "partial", labeled_at: 12 });
    expect(() => openDecision(db, question("one-option", { options: ["yes"] }))).toThrow(/two options/);
  });

  it("feeds the exam only rows predicted before the answer in split exam", async () => {
    const { db } = world();
    shadowJev("yes");
    for (let i = 0; i < 3; i += 1) { await askDecision(db, question(`live${i}`), undefined, 100 + i); answerDecision(db, `live${i}`, { option: "yes" }, "pm", 200 + i); }
    openDecision(db, question("late"), 300); answerDecision(db, "late", { option: "yes" }, "pm", 301); // answered before any prediction
    openDecision(db, question("replayed", { split: "backtest" }), 400); await predictDecision(db, "replayed", undefined, 500); answerDecision(db, "replayed", { option: "yes" }, "backtest", 450);
    const rows = examRows(db);
    expect(rows).toHaveLength(5);
    const [landing] = examAll(rows);
    expect(landing).toMatchObject({ class: "landing", n: 3, k: 3, m: 3, tier: "proposes" });
    expect(landing!.reasons).toContain("n 3 < 20");
  });
});

describe("the surfaces: a task's landing word and a phase's turn", () => {
  it("a task word is a landing decision keyed by run and family; the recorded word answers it", async () => {
    const { db } = world();
    shadowJev("yes");
    await askTaskWord(db, { runId: "run1", projectId: "P", family: "t3", task: { title: "Fix two tests", risk: "high", objective: "make the suite green", invariants: ["no skips"] } }, undefined, 10);
    const row = getDecision(db, wordDecisionId("run1", "t3"))!;
    expect(row).toMatchObject({ surface: "words", class: "landing", risk: "high", project_id: "P", run_id: "run1", options_json: JSON.stringify(["yes", "no"]) });
    expect(JSON.parse(row.situation_json)).toMatchObject({ task: "Fix two tests", risk: "high", objective: "make the suite green", invariants: ["no skips"], family: "t3" });
    answerTaskWord(db, "run1", "t3", "no", "не сейчас", "pm", 20);
    expect(getDecision(db, wordDecisionId("run1", "t3"))).toMatchObject({ judge_verdict: "miss", answered_by: "pm" });
    answerTaskWord(db, "run9", "t1", "yes", "a word with no question", "screen"); // no row: nothing breaks
  });

  it("a phase turn is a process decision; the wave is part of the key", async () => {
    const { db } = world();
    shadowJev("yes");
    const phase = { id: "ph1", projectId: "P", runId: null, title: "Search page", goal: "ship search", stage: "planning" };
    await askPhaseWord(db, phase, "wave", 2, "accept wave 2?", undefined, 10);
    await askPhaseWord(db, phase, "planning", undefined, "approve the plan?", undefined, 11);
    expect(listDecisions(db).map((row) => row.id).sort()).toEqual([phaseDecisionId("ph1", "planning"), phaseDecisionId("ph1", "wave", 2)]);
    expect(JSON.parse(getDecision(db, "phase:ph1:wave:2")!.situation_json)).toMatchObject({ question: "the owner's word at wave (wave 2)", phase: "Search page", stage: "planning", ask: "accept wave 2?" });
    answerPhaseWord(db, "ph1", "wave", 2, "yes", "да", "owner", 20);
    expect(getDecision(db, "phase:ph1:wave:2")).toMatchObject({ class: "process", judge_verdict: "exact", answered_by: "owner" });
    expect(getDecision(db, "phase:ph1:planning")!.answered_at).toBeNull();
  });
});

describe("the backtest replays the owner's past words without touching the exam", () => {
  async function seeded() {
    const { bb, db } = world();
    createRun(db, "run1", "P", "bb", "/repo");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { title: "Add the index", risk: "low", objective: "faster list" } as never });
    createTask(db, { id: "t2", runId: "run1", kind: "bb", contract: { title: "Rename the table", risk: "high" } as never });
    await recordTaskWord(bb.storage.kv as never, "run1", "t1", "yes", "да", 1_000);
    await recordTaskWord(bb.storage.kv as never, "run1", "t2", "no", "нет, рано", 2_000);
    await recordTaskWord(bb.storage.kv as never, "run-gone", "t1", "yes", "да", 3_000);
    insertPhase(db, { id: "ph1", projectId: "P", pmThreadId: "thr1", title: "Search", goal: "ship it", at: 500 });
    savePhase(db, "ph1", { record: { words: [{ turn: "planning", decision: "yes", by: "owner", text: "да", at: 4_000 }, { turn: "wave", decision: "no", by: "owner", text: "нет", at: 5_000, wave: 1 }] } as never, at: 5_000 });
    return { bb, db };
  }

  it("creates backtest rows predicted after the answer, reports per class, skips what the hub no longer has, and adds nothing on a rerun", async () => {
    const { bb, db } = await seeded();
    shadowJev("yes");
    const report = await backtest(db, bb.storage.kv as never, 9_000);
    expect(report.created).toBe(4);
    expect(report.skipped).toEqual(["run-gone:t1: task not on the hub"]);
    expect(report.classes).toEqual([
      { class: "landing", n: 2, decided: 2, exact: 1, miss: 1, deferred: 0, accuracy: 0.5 },
      { class: "process", n: 2, decided: 2, exact: 1, miss: 1, deferred: 0, accuracy: 0.5 },
    ]);
    const t2 = getDecision(db, wordDecisionId("run1", "t2"))!;
    expect(t2).toMatchObject({ split: "backtest", risk: "high", created_at: 2_000, answered_at: 2_000, predicted_at: 9_000, answered_by: "backtest", judge_verdict: "miss" });
    expect(getDecision(db, phaseDecisionId("ph1", "wave", 1))).toMatchObject({ split: "backtest", class: "process", answered_at: 5_000, judge_verdict: "miss" });
    expect(examAll(examRows(db))).toEqual([]);
    expect((await backtest(db, bb.storage.kv as never, 9_500)).created).toBe(0);
  });

  it("a live decision with the same key is never overwritten by the replay", async () => {
    const { bb, db } = await seeded();
    shadowJev("no");
    await askTaskWord(db, { runId: "run1", projectId: "P", family: "t1", task: { title: "Add the index", risk: "low" } }, undefined, 900);
    await backtest(db, bb.storage.kv as never, 9_000);
    expect(getDecision(db, wordDecisionId("run1", "t1"))).toMatchObject({ split: "exam", predicted_at: 900, answered_at: null });
  });
});

describe("bb lane-pilot lead", () => {
  it("journal, exam, backtest and label read and write the same rows", async () => {
    const { bb, db } = world();
    const ctx = { db, kv: bb.storage.kv as never };
    expect((await runLeadCli(ctx, ["journal"])).stdout).toMatch(/empty/);
    expect((await runLeadCli(ctx, ["exam"])).stdout).toMatch(/No class has an exam yet/);
    shadowJev("yes");
    await askDecision(db, question("d1"), undefined, 1_000);
    answerDecision(db, "d1", { option: "yes" }, "pm", 2_000);
    const journal = (await runLeadCli(ctx, ["journal", "--class", "landing"])).stdout!;
    expect(journal).toContain("exam     landing  d1");
    expect(journal).toContain("predicted yes (p 0.90), answered yes by pm → exact");
    expect((await runLeadCli(ctx, ["exam"])).stdout).toContain("landing: N 1, decided 1, matches 1");
    expect((await runLeadCli(ctx, ["label", "d1", "partial"])).stdout).toBe("d1: owner label partial");
    expect((await runLeadCli(ctx, ["label", "d1", "great"])).exitCode).toBe(2);
    expect((await runLeadCli(ctx, ["label", "nope", "exact"])).exitCode).toBe(1);
    expect(JSON.parse((await runLeadCli(ctx, ["exam", "--json"])).stdout!)[0]).toMatchObject({ class: "landing", labeled: 1 });
    expect((await runLeadCli(ctx, ["backtest"])).stdout).toContain("Replayed 0 new decision(s)");
    expect((await runLeadCli(ctx, ["nothing"])).exitCode).toBe(2);
  });
});
