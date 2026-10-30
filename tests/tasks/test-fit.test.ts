import { expect, it } from "vitest";
import { classifyFailure } from "../../src/rooms/runs/failure-class";
import { testFitFindings } from "../../src/rooms/tasks";

const testFile = (before: string, after: string | null) => ({ path: "tests/money.test.ts", before, after });

it("flags a test that was weakened instead of the code", () => {
  const before = `it("adds", () => {\n  expect(add(1, 2)).toBe(3);\n  expect(add(0, 0)).toBe(0);\n});\n`;
  const removed = testFitFindings([testFile(before, `it("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n`)]);
  expect(removed.map((hit) => hit.kind)).toEqual(["assertion_removed"]);
  const weakened = testFitFindings([testFile(before, before.replace(".toBe(3)", ".toBeTruthy()"))]);
  expect(weakened.map((hit) => hit.kind)).toContain("assertion_weakened");
  // The skip word is concatenated: a literal `it.skip(` in this file is a site the deferral scan must answer for.
  const skipped = testFitFindings([testFile(before, before.replace(`it("adds"`, `it.${"skip"}("adds"`))]);
  expect(skipped.map((hit) => hit.kind)).toContain("skipped");
  const expected = testFitFindings([testFile(before, before.replace("toBe(3)", "toBe(4)"))]);
  expect(expected.map((hit) => hit.kind)).toContain("expected_changed");
  const withCode = testFitFindings(
    [testFile(before, before.replace("toBe(3)", "toBe(4)")), { path: "src/add.ts", before: "export const add = (a, b) => a + b;\n", after: "export const add = (a, b) => a + b + 0;\n" }],
  );
  expect(withCode.map((hit) => hit.kind)).not.toContain("expected_changed");
  const narrowed = testFitFindings([{ path: "package.json", before: `{"scripts":{"test":"vitest run"}}\n`, after: `{"scripts":{"test":"vitest run --test-name-pattern add"}}\n` }]);
  expect(narrowed.map((hit) => hit.kind)).toEqual(["verification_narrowed"]);
  expect(testFitFindings([{ path: "tests/new.test.ts", before: null, after: before }])).toEqual([]);
  expect(classifyFailure("validation_failed", "test_fit: tests/money.test.ts: removed an assertion")).toEqual({ cls: "task", confident: true });
});

it("a deleted test file is every assertion removed, not an edit out of scope", () => {
  const before = `it("adds", () => {
  expect(add(1, 2)).toBe(3);
  expect(add(0, 0)).toBe(0);
});
`;
  const hits = testFitFindings([{ path: "tests/money.test.ts", before, after: null }]);
  expect(hits.map((hit) => hit.kind)).toEqual(["assertion_removed"]);
});

it("a reflowed assert.rejects is the same check; dropping it is still a removal (magicseo F1.2)", () => {
  const before = `it("pages", async () => {\n  await assert.rejects(\n    client.catalogItems(-1),\n    /bad offset/,\n  );\n});\n`;
  const reflowed = `it("pages", async () => {\n  await assert.rejects(client.catalogItems(-1), /bad offset/);\n});\n`;
  expect(testFitFindings([testFile(before, reflowed)])).toEqual([]);
  expect(testFitFindings([testFile(before, `it("pages", async () => {\n  await client.catalogItems(0);\n});\n`)]).map((hit) => hit.kind)).toContain("assertion_removed");
});
