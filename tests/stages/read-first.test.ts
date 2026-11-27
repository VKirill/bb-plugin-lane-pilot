import { describe, expect, it } from "vitest";
import { parseReadFirstHints } from "../../src/rooms/tasks";

describe("task read_first execution hints", () => {
  it("preserves whole-file hints and parses 1-based inclusive windows", () => {
    expect(parseReadFirstHints(["README.md", "src/server.ts L10-L24, L30-L33"])).toEqual([
      { path:"README.md", windows:[] },
      { path:"src/server.ts", windows:[{ startLine:10, endLine:24 }, { startLine:30, endLine:33 }] },
    ]);
  });

  it.each(["../outside.md L1-L2", "/etc/passwd L1-L2", "C:\\secret.md L1-L2"])(
    "rejects unsafe read_first path %s", (hint) => {
      expect(() => parseReadFirstHints([hint])).toThrow("project-relative");
    },
  );
});
