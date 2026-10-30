import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { createJev, type JevClient } from "@lane-pilot/jev";
import { directTestMatches, importLinkedTests, suggestTests, testHintLine, testPickJudgment, testSignature } from "../../src/rooms/verification/test-hint";

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

function jevWith(noul: number) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      return { ok: true, model: "jev-test", usage: { input_tokens: 800, output_tokens: 30 }, latencyMs: 80, attempts: 1,
        answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul }])) };
    },
  };
  return { db, jev: createJev({ client, db }) };
}
const read = async (path: string) => contents[path] ?? "";

describe("verify.test_pick: ranked test hint for a change", () => {
  it("name-mirrored and import-linked tests are found in code, without asking", async () => {
    expect(directTestMatches(["src/rooms/writer/foo.ts"], repo)).toEqual(["tests/jev/foo.test.ts"]);
    expect(await importLinkedTests(["src/rooms/writer/foo.ts"], repo.filter((f) => f.includes("test")), read)).toEqual(["tests/jev/other.test.ts"]);
  });

  it("suggestTests ranks name/import hits first and adds Jev picks", async () => {
    const { jev } = jevWith(0.9);
    const hint = await suggestTests(jev, { changedFiles: ["src/rooms/writer/foo.ts"], repoFiles: repo, readFile: read },
      { settings: { "jev.modes": "verify.test_pick=active" } });
    expect(hint[0]).toMatchObject({ file: "tests/jev/foo.test.ts", reason: "name" });
    expect(hint.map((row) => row.file)).toContain("tests/jev/other.test.ts");
    expect(testHintLine(hint)).toContain("test file");
    expect(testHintLine(hint)).toContain("tests/jev/foo.test.ts");
  });

  it("shadow: Jev is asked and recorded, name/import hints still stand", async () => {
    const { db, jev } = jevWith(0.9);
    const hint = await suggestTests(jev, { changedFiles: ["src/rooms/writer/foo.ts"], repoFiles: repo, readFile: read }, { settings: {} });
    expect(hint.map((row) => row.reason)).not.toContain("jev");
    expect(hint).toHaveLength(2);
    expect((db.prepare("SELECT judgment FROM lane_pilot_jev_receipt").get() as { judgment: string }).judgment).toBe("verify.test_pick");
  });

  it("no change, no tests, no Jev: empty hint", async () => {
    expect(await suggestTests(null, { changedFiles: [], repoFiles: repo })).toEqual([]);
    expect(await suggestTests(null, { changedFiles: ["src/x.ts"], repoFiles: [] })).toEqual([]);
    expect(testHintLine([])).toBe("");
  });

  it("signature keeps imports and test names; decide keeps at min_p", () => {
    const sig = testSignature(contents["tests/jev/other.test.ts"]!);
    expect(sig).toContain("import");
    expect(sig).toContain("describe");
    const input = { changedFiles: ["a"], diffHead: "", tests: [{ file: "t", signature: "s" }] };
    expect(testPickJudgment.decide({ t1: { type: "noul" as const, noul: 0.8 } }, { min_p: 0.4 }, input)).toEqual({ decision: [true] });
    expect(testPickJudgment.fallback(input)).toEqual([false]);
  });
});
