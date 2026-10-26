import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { noTestRanReason, testSummaries } from "../../src/rooms/tasks/server/tests-ran";

/** Real outputs, captured 2026-10-26 by running vitest 4.1 and node 26 `--test` in a scratch dir (exit codes in the comments). */
const out = (name: string) => readFileSync(new URL(`../fixtures/test-runner-output/${name}.txt`, import.meta.url), "utf8");

describe("noTestRanReason: a check that exited 0 must have run a test", () => {
  it("vitest -t with a name that matches nothing: 4 skipped, exit 0", () => {
    expect(testSummaries(out("vitest-filter-none"))).toEqual([{ runner: "vitest", executed: 0, notRun: 4, detail: "4 skipped" }]);
    const reason = noTestRanReason(out("vitest-filter-none"))!;
    expect(reason).toContain("the check exited 0 but ran no test: 4 skipped");
    expect(reason).toContain("filter");
  });

  it("several files, every test skipped by the filter", () => {
    expect(noTestRanReason(out("vitest-two-files-none"))).toContain("6 skipped");
  });

  it("vitest passWithNoTests from the config: «No test files found, exiting with code 0»", () => {
    expect(testSummaries(out("vitest-nofiles-pass"))).toEqual([{ runner: "vitest", executed: 0, notRun: 0, detail: "no test files found" }]);
    expect(noTestRanReason(out("vitest-nofiles-pass"))).toContain("no test files found");
  });

  it("vitest with passed, skipped and todo tests: the passed ones count, skipped and todo do not", () => {
    expect(testSummaries(out("vitest-mixed"))).toEqual([{ runner: "vitest", executed: 2, notRun: 2, detail: "1 skipped, 1 todo" }]);
    expect(noTestRanReason(out("vitest-mixed"))).toBeNull();
    expect(noTestRanReason(out("vitest-two-files"))).toBeNull();
  });

  it("vitest that exited 1 from an unhandled error still counts the tests it ran", () => {
    expect(testSummaries(out("vitest-unhandled"))[0]).toMatchObject({ executed: 2 });
    expect(noTestRanReason(out("vitest-unhandled"))).toBeNull();
  });

  it("node --test (spec reporter): a pattern that matches nothing, run in the process (isolation none), has pass 0 fail 0", () => {
    expect(testSummaries(out("node-isolation-none-filter"))).toEqual([{ runner: "node", executed: 0, notRun: 0, detail: "" }]);
    expect(noTestRanReason(out("node-isolation-none-filter"))).toContain("ran no test");
  });

  it("node --test with only a skipped test: pass 0, skipped 1", () => {
    expect(testSummaries(out("node-skipped-only"))).toEqual([{ runner: "node", executed: 0, notRun: 1, detail: "1 skipped" }]);
    expect(noTestRanReason(out("node-skipped-only"))).toContain("1 skipped");
  });

  it("node --test with passing, skipped and todo tests (spec and tap)", () => {
    expect(testSummaries(out("node-pass"))).toEqual([{ runner: "node", executed: 2, notRun: 2, detail: "1 skipped, 1 todo" }]);
    expect(testSummaries(out("node-tap-pass"))[0]).toMatchObject({ runner: "node", executed: 2 });
    expect(noTestRanReason(out("node-pass"))).toBeNull();
    expect(noTestRanReason(out("node-tap-pass"))).toBeNull();
  });

  it("node --test in its default isolation counts the test FILE as a test, so a name pattern that matches nothing is not seen (limit of the summary)", () => {
    expect(testSummaries(out("node-pattern-none"))[0]).toMatchObject({ executed: 1 });
    expect(noTestRanReason(out("node-pattern-none"))).toBeNull();
  });

  it("jest summary lines (jest's documented format)", () => {
    expect(noTestRanReason("Test Suites: 1 skipped, 0 of 1 total\nTests:       3 skipped, 3 total\nSnapshots:   0 total\n")).toContain("3 skipped (jest)");
    expect(noTestRanReason("Tests:       1 todo, 1 total\n")).toContain("1 todo");
    expect(noTestRanReason("Tests:       1 skipped, 2 passed, 3 total\n")).toBeNull();
    expect(noTestRanReason("No tests found, exiting with code 0\n")).toContain("no tests found");
  });

  it("pytest's last line (pytest's documented format)", () => {
    expect(noTestRanReason("============ no tests ran in 0.01s ============\n")).toContain("no tests ran");
    expect(noTestRanReason("===== 4 deselected in 0.02s =====\n")).toContain("4 deselected");
    expect(noTestRanReason("2 skipped in 0.01s\n")).toContain("2 skipped");
    expect(noTestRanReason("===== 3 passed, 1 skipped in 0.12s =====\n")).toBeNull();
    expect(noTestRanReason("1 passed, 4 deselected in 0.02s\n")).toBeNull();
  });

  it("output that is not a test runner's summary is left alone", () => {
    expect(noTestRanReason("")).toBeNull();
    expect(noTestRanReason("src/a.ts(3,1): error TS2322: Type 'x' is not assignable\n")).toBeNull();
    expect(noTestRanReason("✔ no lint problems\n12 files in 2s\n")).toBeNull();
    // python's unittest exits 5 by itself on zero tests; its «Ran 0 tests» is not a summary this reads
    expect(noTestRanReason(out("unittest-none"))).toBeNull();
  });

  it("several summaries are added up: one mistyped filter beside a real run still leaves tests that ran", () => {
    expect(noTestRanReason(`${out("vitest-filter-none")}\n${out("vitest-mixed")}`)).toBeNull();
    expect(noTestRanReason(`${out("vitest-filter-none")}\n${out("node-skipped-only")}`)).toMatch(/4 skipped.*1 skipped|1 skipped.*4 skipped/);
  });

  it("terminal escapes around the summary do not hide it", () => {
    expect(noTestRanReason("\x1b[2m      Tests \x1b[22m \x1b[33m4 skipped\x1b[39m\x1b[90m (4)\x1b[39m\r\n")).toContain("4 skipped");
  });
});
