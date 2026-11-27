import { describe, expect, it } from "vitest";
import { fileFingerprint, filesDrifted, pathsNamed } from "../src/index";

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
