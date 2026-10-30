import { describe, expect, it } from "vitest";
import { memoryEntrySalience } from "../packages/memory-core/src";

// arXiv #2 SLICE-Mem: admission scores a candidate by what a future task could reuse —
// retrievable concepts, a concrete claim, enough text to carry it. No model call.
describe("salience-gated admission (SLICE-Mem)", () => {
  it("drops a note with no concepts, no concrete claim and almost no text", () => {
    expect(memoryEntrySalience({ kind: "note", content: "It went fine.", concepts: [] })).toBeLessThan(40);
  });
  it("keeps a retrievable note with a concrete claim", () => {
    expect(memoryEntrySalience({ kind: "note", content: "The deploy gateway listens on port 4000; the old 3000 binding is gone.", concepts: ["deploy", "port"] })).toBeGreaterThanOrEqual(40);
  });
  it("a zero floor admits everything", () => {
    expect(memoryEntrySalience({ kind: "note", content: "ok", concepts: [] })).toBeGreaterThanOrEqual(0);
  });
});
