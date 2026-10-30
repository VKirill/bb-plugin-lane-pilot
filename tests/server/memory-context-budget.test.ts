import { describe, expect, it } from "vitest";
import { memoryContext, type MemoryRecord } from "../../packages/memory-core/src";

/** F10-4: the kind/concepts header is part of the line the budget pays for. */
function note(concepts: string[]): MemoryRecord {
  return { id: "port-note", projectId: "p", personalBot: "off", sourceSha256: "", createdAt: 1, kind: "note", content: "port", concepts, status: "active", trust: "confirmed", useCount: 0, acceptedCount: 0 };
}

describe("memory context budget", () => {
  it("counts the kind and concepts header, so a line that only fits as bare content is cut", () => {
    const concepts = Array.from({ length: 24 }, (_, index) => `concept${index}`.padEnd(20, "x"));
    const packed = memoryContext([note(concepts)], "port", 2);
    expect(packed.estimatedTokens).toBeLessThanOrEqual(2);
    expect(packed.records).toEqual([]);
    expect(packed.cut.map((record) => record.id)).toEqual(["port-note"]);
  });
});
