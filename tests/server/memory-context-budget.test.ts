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

  it("shows a head line (date, id, start of the text) for a record that does not fit whole, instead of dropping it", () => {
    const big = (id: string, createdAt: number): MemoryRecord => ({ ...note(["port"]), id, createdAt, content: `port ${id} ${"filler ".repeat(300)}` });
    const records = [big("aaaaaaaaaaaaaaaa", 2), big("bbbbbbbbbbbbbbbb", 1)];
    const on = memoryContext(records, "port", 600);
    expect(on.records.map((record) => record.id)).toEqual(["aaaaaaaaaaaaaaaa"]);
    expect(on.heads.map((record) => record.id)).toEqual(["bbbbbbbbbbbbbbbb"]);
    expect(on.text).toContain("head; id=bbbbbbbbbbbb] port bbbbbbbbbbbbbbbb");
    expect(on.estimatedTokens).toBeLessThanOrEqual(600);
    const off = memoryContext(records, "port", 600, { heads: false });
    expect(off.heads).toEqual([]);
    expect(off.cut.map((record) => record.id)).toEqual(["bbbbbbbbbbbbbbbb"]);
    expect(off.text).not.toContain("bbbbbbbbbbbb");
  });

  it("stops adding head lines when they no longer fit", () => {
    const records = ["a", "b", "c"].map((id, index) => ({ ...note(["port"]), id: id.repeat(16), createdAt: index, content: `port ${"filler ".repeat(300)}` }));
    const packed = memoryContext(records, "port", 40);
    expect(packed.records).toEqual([]);
    expect(packed.heads.length).toBeLessThan(3);
    expect(packed.estimatedTokens).toBeLessThanOrEqual(40);
    expect(packed.heads.length + packed.cut.length).toBe(3);
  });
});
