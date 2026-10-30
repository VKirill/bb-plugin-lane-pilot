import { describe, expect, it } from "vitest";
import { memoryRerankJudgment } from "@lane-pilot/jev/judgments/memory-rerank";

describe("memory.rerank", () => {
  it("keeps passages at the bar, in order", () => {
    const input = { query: "q", passages: ["a", "b", "c"] };
    const d = memoryRerankJudgment.decide({ p0: { type: "noul", noul: 0.9 }, p1: { type: "noul", noul: 0.2 }, p2: { type: "noul", noul: 0.7 } }, { keep_p: 0.5 }, input);
    expect(d.decision?.keep).toEqual([0, 2]);
    expect(d.decision?.scores).toEqual([0.9, 0.2, 0.7]);
  });
  it("fallback keeps everything; stateBuilder whitelists fields", () => {
    expect(memoryRerankJudgment.fallback({ query: "q", passages: ["a", "b"] }).keep).toEqual([0, 1]);
    const state = memoryRerankJudgment.stateBuilder({ query: "q", passages: ["x".repeat(3000)], extra: "drop" } as never) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["passages", "query"]);
    expect((state.passages as Record<string, string>).p0!.length).toBeLessThanOrEqual(1500);
  });
});
