import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setJevForTests } from "@lane-pilot/jev";
import { answerDecision, openDecision } from "../../src/rooms/lead/server/journal";
import { MEMORY_EXAM_MIN_PROBES, formatMemoryExam, runMemoryExam } from "../../src/rooms/lead/server/memory-exam";
import { openDatabase } from "../../src/rooms/storage/database";

const world = () => { const { bb } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, db: openDatabase(bb) }; };
afterEach(() => setJevForTests(null));
/** A predictor that knows the owner only through his history: with it, it repeats his last answer; with none, it defers. */
const historyJev = (calls: Array<{ history: number; situations: string[] }>) => setJevForTests({ enabled: () => true, judge: async (_j: unknown, input: { history: Array<{ answer: string; situation: string }> }) => {
  calls.push({ history: input.history.length, situations: input.history.map((row) => row.situation) });
  return input.history.length ? { by: "jev", decision: { option: input.history[0]!.answer, p: 0.9 }, receiptId: null, answers: {} } : { by: "jev", decision: { option: null, p: 0.4 }, receiptId: null, answers: {} };
} } as never);
const seed = (db: ReturnType<typeof openDatabase>, id: string, option: string, at: number) => {
  openDecision(db, { id, surface: "words", class: "landing", situation: { task: id }, options: ["yes", "no"] }, at);
  answerDecision(db, id, { option }, "owner", at + 100);
};

describe("the memory exam (roadmap §6: recall probes and decisions with an empty control)", () => {
  it("predicts the answered rows twice, with the memory the live predictor has and with none: the gain is what the memory adds, and the history never looks forward", async () => {
    const { db } = world();
    const calls: Array<{ history: number; situations: string[] }> = [];
    historyJev(calls);
    for (let i = 0; i < 6; i += 1) seed(db, `d${i}`, "yes", 100 + i);
    const exam = await runMemoryExam(db, { recall: false, now: 1_000 });
    expect(exam.decisions).toEqual({ n: 6, withMemory: { decided: 5, exact: 5 }, control: { decided: 0, exact: 0 }, gain: 5, predictor: "jev" });
    // The newest row sees the five earlier answers, never its own or a later one; the control arm sees nothing.
    expect(Math.max(...calls.map((call) => call.history))).toBe(5);
    expect(calls.filter((call) => call.history === 0)).toHaveLength(7);
    const newest = calls.find((call) => call.history === 5)!;
    expect(newest.situations.some((text) => text.includes("d5"))).toBe(false);
    expect(exam.recall).toBeNull();
    expect(exam.caveats).toEqual([expect.stringContaining("fewer than 20")]);
    expect(formatMemoryExam(exam)).toContain("with memory: decided 5/6, exact 5 (100 %); empty control: decided 0/6, exact 0; gain +5");
    // A memory that misleads shows as a negative gain, never hidden.
    seed(db, "turn", "no", 900);
    const turned = await runMemoryExam(db, { recall: false, limit: 1, now: 2_000 });
    expect(turned.decisions).toMatchObject({ n: 1, withMemory: { decided: 1, exact: 0 }, gain: 0 });
  });

  it("without Jev both arms defer and the exam says so; an empty journal and an empty hub are caveats, not errors", async () => {
    const { db } = world();
    const empty = await runMemoryExam(db, { now: 1_000 });
    expect(empty.decisions).toMatchObject({ n: 0, predictor: "none", gain: 0 });
    expect(empty.caveats.some((line) => line.startsWith("decisions: the journal has no answered rows"))).toBe(true);
    expect(empty.recall === null || empty.recall.probes < MEMORY_EXAM_MIN_PROBES).toBe(true);
    expect(empty.recall === null || empty.recall.enough === false).toBe(true);
    seed(db, "cold", "yes", 100);
    const cold = await runMemoryExam(db, { recall: false, now: 1_000 });
    expect(cold.decisions).toMatchObject({ n: 1, predictor: "none", withMemory: { decided: 0, exact: 0 }, control: { decided: 0, exact: 0 } });
    expect(cold.caveats.some((line) => line.includes("Jev answered nothing"))).toBe(true);
    expect(formatMemoryExam(cold)).toContain("recall: not measured");
  });
});
