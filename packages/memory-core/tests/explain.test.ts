import { describe, expect, it } from "vitest";
import { explainMemory, fileFingerprint, filesDrifted, pathsNamed, type MemoryRecord } from "../src/index";

const note = (id: string, content: string): MemoryRecord => ({
  id, projectId: "p", personalBot: "", kind: "note", content, concepts: ["memory"], sourceSha256: "a".repeat(64), createdAt: 1,
});

describe("memory pack explain", () => {
  it("[sma:k_lib_explain_mem] [sma:k_v_mem_explain] a matched note that does not fit the budget is cut, and a note with no shared word is out", () => {
    const records = [
      note("keep", "deploy staging checklist for the hub"),
      note("cut", "deploy staging checklist extra words ".repeat(40)),
      note("miss", "borscht recipe with beets"),
    ];
    const lines = explainMemory(records, "deploy staging checklist", 30);
    expect(lines.find((line) => line.startsWith("deliver keep"))).toBeTruthy();
    expect(lines.find((line) => line.startsWith("reject cut"))).toMatch(/context budget/);
    expect(lines.find((line) => line.startsWith("reject miss"))).toMatch(/no token overlap/);
  });
});

describe("memory file drift", () => {
  it("a note is due for a recheck when a file it names changed, and a missing file is a change", () => {
    expect(pathsNamed("see src/rooms/memory/memory.ts and not a word")).toEqual(["src/rooms/memory/memory.ts"]);
    const files = new Map<string, Uint8Array | null>([["src/a.ts", new TextEncoder().encode("one")]]);
    const read = (path: string) => files.get(path) ?? null;
    const stored = fileFingerprint([{ path: "src/a.ts", bytes: files.get("src/a.ts")! }]);
    expect(filesDrifted(stored, ["src/a.ts"], read)).toBe(false);
    files.set("src/a.ts", new TextEncoder().encode("two"));
    expect(filesDrifted(stored, ["src/a.ts"], read)).toBe(true);
    files.set("src/a.ts", null);
    expect(filesDrifted(stored, ["src/a.ts"], read)).toBe(true);
    expect(filesDrifted(null, ["src/a.ts"], read)).toBe(false);
    expect(filesDrifted(stored, [], read)).toBe(false);
  });
});
