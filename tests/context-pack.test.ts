import { describe, expect, it } from "vitest";
import { buildContextPack, memoryCandidates, shadowPackCompare } from "../packages/memory-core/src";

const cand = (id: string, over: Partial<Parameters<typeof buildContextPack>[0]["candidates"][number]> = {}) =>
  ({ id, kind: "note" as const, content: `note ${id}`, ...over });
const base = { projectId: "P", role: "writer", audience: "subagent", budget: 1600, sectionChain: ["section:a"] };

describe("M4 context pack", () => {
  it("clamps the budget to the role cap: a helper never gets more than 600 tokens", () => {
    const big = cand("n1", { content: "x".repeat(4000) });
    const pack = buildContextPack({ ...base, role: "helper", budget: 1600, candidates: [big] });
    expect(pack.estimatedTokens).toBeLessThanOrEqual(600);
    expect(pack.sources[0]!.packed).toBe(false);
    expect(pack.sources[0]!.reason).toBe("cut:over-budget");
  });

  it("a required rule that does not fit fails the build naming the source, it is not silently cut", () => {
    const rule = cand("r1", { kind: "rule", required: true, content: "x".repeat(6000) });
    expect(() => buildContextPack({ ...base, role: "helper", candidates: [rule] })).toThrowError("context_pack_oversized:rule:r1");
  });

  it("optional notes are cut before required rules", () => {
    const rule = cand("r1", { kind: "rule", required: true, content: "- always verify" });
    const note = cand("n1", { content: "y".repeat(7000) });
    const pack = buildContextPack({ ...base, candidates: [note, rule] });
    expect(pack.sources.find((s) => s.id === "r1")!.packed).toBe(true);
    expect(pack.sources.find((s) => s.id === "n1")!.packed).toBe(false);
  });

  it("a stale note is excluded for re-verification, never delivered silently", () => {
    const pack = buildContextPack({ ...base, candidates: [cand("n1", { stale: true })] });
    expect(pack.sources[0]!.reason).toBe("stale:needs_review");
    expect(pack.packedBytes).toBe(0);
  });

  it("without a section chain only an explicitly root-whitelisted candidate packs", () => {
    const pack = buildContextPack({ ...base, sectionChain: [], rootWhitelist: new Set(["n2"]),
      candidates: [cand("n1"), cand("n2")] });
    expect(pack.sources.find((s) => s.id === "n1")!.reason).toBe("scope:not-deliverable");
    expect(pack.sources.find((s) => s.id === "n2")!.packed).toBe(true);
  });

  it("a note of another section is not delivered into this chain", () => {
    const pack = buildContextPack({ ...base, sectionChain: ["section:a"],
      candidates: [cand("n1", { scope: ["section:b"] }), cand("n2", { scope: ["section:a"] })] });
    expect(pack.sources.find((s) => s.id === "n1")!.packed).toBe(false);
    expect(pack.sources.find((s) => s.id === "n2")!.packed).toBe(true);
  });

  it("one pack per identity: same inputs, same packId", () => {
    const input = { ...base, sectionChain: ["section:a"], candidates: [cand("n1")] };
    expect(buildContextPack(input).packId).toBe(buildContextPack(input).packId);
    expect(buildContextPack({ ...input, role: "pm" }).packId).not.toBe(buildContextPack(input).packId);
  });

  it("shadow compare reports kept/added/dropped and exclusion reasons", () => {
    const pack = buildContextPack({ ...base, candidates: [cand("n1"), cand("n2", { stale: true })] });
    const diff = shadowPackCompare(["n1", "n3"], 100, pack);
    expect(diff).toMatchObject({ kept: ["n1"], added: [], dropped: ["n3"], oldBytes: 100 });
    expect(diff.excludedReasons["n2"]).toBe("stale:needs_review");
  });

  it("memoryCandidates turns records into note candidates with an id each", () => {
    const rows = memoryCandidates([{ id: "m1", kind: "note", content: "deploy port 4000", concepts: ["deploy"] } as never]);
    expect(rows[0]).toMatchObject({ id: "m1", kind: "note" });
    expect(rows[0]!.content).toContain("deploy port 4000");
  });
});
