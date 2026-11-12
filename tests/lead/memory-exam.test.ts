import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
const evalRunner = { load: () => ({ notes: [], questions: [], origin: "live" as const }), run: async () => ({ sizes: [], caveats: [] }) };
import { describe, expect, it } from "vitest";
import { answerDecision, openDecision } from "../../src/rooms/lead/server/journal";
import { MEMORY_EXAM_MIN_PROBES, formatMemoryExam, runMemoryExam } from "../../src/rooms/lead/server/memory-exam";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";

const world = () => { const { bb } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, db: openDatabase(bb) }; };
const seed = (db: ReturnType<typeof openDatabase>, id: string, option: string, at: number) => {
  openDecision(db, { id, surface: "words", class: "landing", situation: { task: id }, options: ["yes", "no"] }, at);
  answerDecision(db, id, { option }, "owner", at + 100);
};

describe("the memory exam (roadmap §6: recall probes and decisions with an empty control)", () => {
  it("the lead has no predictor: both arms defer every answered row, the gain is zero and the exam says so", async () => {
    const { db } = world();
    for (let i = 0; i < 6; i += 1) seed(db, `d${i}`, "yes", 100 + i);
    const exam = await runMemoryExam(db, { recall: false, now: 1_000, migrations }, evalRunner);
    expect(exam.decisions).toEqual({ n: 6, withMemory: { decided: 0, exact: 0 }, control: { decided: 0, exact: 0 }, gain: 0, predictor: "none" });
    expect(exam.recall).toBeNull();
    expect(exam.caveats).toEqual([expect.stringContaining("no predictor")]);
    expect(formatMemoryExam(exam)).toContain("with memory: decided 0/6, exact 0; empty control: decided 0/6, exact 0; gain +0");
  });

  it("an empty journal and an empty hub are caveats, not errors", async () => {
    const { db } = world();
    const empty = await runMemoryExam(db, { now: 1_000, migrations }, evalRunner);
    expect(empty.decisions).toMatchObject({ n: 0, predictor: "none", gain: 0 });
    expect(empty.caveats.some((line) => line.startsWith("decisions: the journal has no answered rows"))).toBe(true);
    expect(empty.recall === null || empty.recall.probes < MEMORY_EXAM_MIN_PROBES).toBe(true);
    expect(empty.recall === null || empty.recall.enough === false).toBe(true);
    seed(db, "cold", "yes", 100);
    const cold = await runMemoryExam(db, { recall: false, now: 1_000, migrations }, evalRunner);
    expect(cold.decisions).toMatchObject({ n: 1, predictor: "none", withMemory: { decided: 0, exact: 0 }, control: { decided: 0, exact: 0 } });
    expect(cold.caveats.some((line) => line.includes("no predictor"))).toBe(true);
    expect(formatMemoryExam(cold)).toContain("recall: not measured");
  });
});
