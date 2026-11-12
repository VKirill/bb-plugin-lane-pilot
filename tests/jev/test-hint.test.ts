import { describe, expect, it } from "vitest";
import { directTestMatches, importLinkedTests, suggestTests, testHintLine } from "../../src/rooms/verification/test-hint";

const repo = [
  "src/rooms/writer/log-trim.ts",
  "src/rooms/writer/foo.ts",
  "tests/jev/log-trim.test.ts",
  "tests/jev/foo.test.ts",
  "tests/jev/other.test.ts",
];
const contents: Record<string, string> = {
  "tests/jev/other.test.ts": "import { x } from \"../../src/rooms/writer/foo\";\ndescribe(\"foo\", () => {});",
  "tests/jev/foo.test.ts": "describe(\"foo\", () => {});",
};

const read = async (path: string) => contents[path] ?? "";

describe("ranked test hint for a change", () => {
  it("name-mirrored and import-linked tests are found in code, without asking", async () => {
    expect(directTestMatches(["src/rooms/writer/foo.ts"], repo)).toEqual(["tests/jev/foo.test.ts"]);
    expect(await importLinkedTests(["src/rooms/writer/foo.ts"], repo.filter((f) => f.includes("test")), read)).toEqual(["tests/jev/other.test.ts"]);
  });

  it("suggestTests ranks name/import hits", async () => {
    const hint = await suggestTests({ changedFiles: ["src/rooms/writer/foo.ts"], repoFiles: repo, readFile: read });
    expect(hint[0]).toMatchObject({ file: "tests/jev/foo.test.ts", reason: "name" });
    expect(hint.map((row) => row.file)).toContain("tests/jev/other.test.ts");
    expect(hint).toHaveLength(2);
    expect(testHintLine(hint)).toContain("test file");
    expect(testHintLine(hint)).toContain("tests/jev/foo.test.ts");
  });

  it("no change, no tests: empty hint", async () => {
    expect(await suggestTests({ changedFiles: [], repoFiles: repo })).toEqual([]);
    expect(await suggestTests({ changedFiles: ["src/x.ts"], repoFiles: [] })).toEqual([]);
    expect(testHintLine([])).toBe("");
  });
});
