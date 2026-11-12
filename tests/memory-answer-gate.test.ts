import { describe, expect, it } from "vitest";
import { ANSWER_GATE, answerProbability, relevantRecords } from "../packages/memory-core/src";
import type { MemoryRecord } from "../packages/memory-core/src";

/** The answer gate replaced the model rerank: arithmetic on the search score, no model call. */
const rec = (id: string, similarity?: number): MemoryRecord => ({ id, content: `note ${id}`, concepts: [], kind: "note", similarity } as unknown as MemoryRecord);
const rel = (weights: Record<string, number> = {}) => new Map(Object.entries(weights).map(([id, score]) => [id, { shared: 1, score, anchor: false }]));
const spread = (top: number, rest: number) => [rec("a", top), ...Array.from({ length: 12 }, (_, i) => rec(`r${i}`, rest - i * 0.002))];

describe("answer gate", () => {
  it("cannot tell without a meaning search or with fewer than three records", () => {
    expect(answerProbability([rec("a"), rec("b"), rec("c")], rel())).toBeNull();
    expect(answerProbability([rec("a", 0.9), rec("b", 0.5)], rel())).toBeNull();
  });
  it("a record that stands far above the rest reads as an answer, a flat list as nothing", () => {
    const sure = answerProbability(spread(0.86, 0.8), rel({ a: 2 }));
    const flat = answerProbability(spread(0.7, 0.69), rel());
    expect(sure).toBeGreaterThan(ANSWER_GATE.min);
    expect(flat).toBeLessThan(ANSWER_GATE.min);
  });
  it("the gate empties the list only when asked to and the search looks like no answer", () => {
    const records = spread(0.7, 0.69);
    const db = { prepare: () => ({ get: () => ({ n: 0, last: 0, size: 0 }), iterate: () => [] }) } as never;
    expect(relevantRecords(db, "P", "what shoe size", records, { gate: true }).length).toBe(0);
    expect(relevantRecords(db, "P", "what shoe size", records).length).toBeGreaterThan(0);
    expect(relevantRecords(db, "P", "what shoe size", records, { gate: true, floor: null }).length).toBe(records.length);
  });
});
