/**
 * A green check that ran zero tests proves nothing. Exit 0 also comes from a mistyped `-t`/`--testNamePattern` (vitest prints
 * «Tests 30 skipped (30)» and exits 0), a `passWithNoTests` kept in package.json or the vitest config, and a `node --test` filter
 * that matches nothing; the static lint (`passWithNoTestsReason`) sees only the flag in the command text. This reads the runner's own
 * summary after the command exited 0. Rule from Matvey Maslov's tests-ran (MIT, agent-dev-tools): executed = passed + failed;
 * skipped, todo, pending, cancelled and disabled tests do not count. Output that is not a recognised test summary (tsc, lint,
 * a script) says nothing here, so it is never turned into a failure.
 */

import { cleanCheckOutput } from "@lane-pilot/kit";

export type TestSummary = {
  runner: "vitest" | "jest" | "node" | "pytest";
  /** Tests that ran: passed + failed. */
  executed: number;
  /** Tests that were counted but did not run: skipped, todo, pending, cancelled, deselected. */
  notRun: number;
  /** The runner's own words for what did not run, e.g. «4 skipped». */
  detail: string;
};

const NOT_RUN_WORDS = new Set(["skipped", "todo", "pending", "cancelled", "disabled", "deselected"]);
const RAN_WORDS = new Set(["passed", "failed", "xfailed", "xpassed"]);

/** `2 passed | 1 skipped` (vitest), `1 skipped, 1 total` (jest), `3 passed, 1 skipped` (pytest): every `N word` pair, `total` and brackets left out. */
function countsOf(text: string): { executed: number; notRun: number; parts: string[] } {
  let executed = 0, notRun = 0;
  const parts: string[] = [];
  for (const [, count, word] of text.matchAll(/(\d+)\s+([a-z]+)/g)) {
    if (RAN_WORDS.has(word!)) executed += Number(count);
    else if (NOT_RUN_WORDS.has(word!)) { notRun += Number(count); parts.push(`${count} ${word}`); }
  }
  return { executed, notRun, parts };
}

/** node's test runner: `ℹ tests 4` (spec) or `# tests 4` (tap), unindented; a new `tests` line starts the next summary. */
function nodeSummaries(lines: string[]): TestSummary[] {
  const found: TestSummary[] = [];
  let block: Record<string, number> = {};
  const close = () => {
    if (block.tests !== undefined && block.pass !== undefined && block.fail !== undefined) {
      const parts = ["skipped", "todo", "cancelled"].filter((key) => block[key]).map((key) => `${block[key]} ${key}`);
      found.push({ runner: "node", executed: block.pass + block.fail, notRun: (block.skipped ?? 0) + (block.todo ?? 0) + (block.cancelled ?? 0), detail: parts.join(", ") });
    }
    block = {};
  };
  for (const line of lines) {
    const hit = /^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);
    if (!hit) continue;
    if (hit[1] === "tests") close();
    block[hit[1]!] = Number(hit[2]);
  }
  close();
  return found;
}

/** Every test-runner summary in the output, in order; empty when the output is not a test runner's. */
export function testSummaries(output: string): TestSummary[] {
  const lines = cleanCheckOutput(output).split("\n").map((line) => line.trimEnd());
  const found = nodeSummaries(lines);
  for (const line of lines) {
    // vitest: `      Tests  2 passed | 1 skipped | 1 todo (4)`; jest: `Tests:       1 skipped, 1 total`.
    const tests = /^\s*Tests(:)?\s+(\d.*)$/.exec(line);
    if (tests && /\d+\s+(?:passed|failed|skipped|todo|pending)/.test(tests[2]!)) {
      const { executed, notRun, parts } = countsOf(tests[2]!);
      found.push({ runner: tests[1] ? "jest" : "vitest", executed, notRun, detail: parts.join(", ") });
      continue;
    }
    // `vitest run nofile` with passWithNoTests in the config, and jest's twin.
    const none = /^(No test files found|No tests found), exiting with code 0\b/.exec(line);
    if (none) { found.push({ runner: none[1] === "No tests found" ? "jest" : "vitest", executed: 0, notRun: 0, detail: none[1]!.toLowerCase() }); continue; }
    // pytest's last line: `===== 3 passed, 1 skipped in 0.12s =====`, `1 passed, 4 deselected in 0.02s`, `no tests ran in 0.01s`.
    const pytest = /^(?:=+\s*)?((?:\d+\s+(?:passed|failed|skipped|deselected|xfailed|xpassed|errors?|warnings?|rerun)(?:,\s*)?)+|no tests ran)\s+in\s+\d+(?:\.\d+)?s\b/i.exec(line);
    if (pytest) {
      const { executed, notRun, parts } = countsOf(pytest[1]!);
      found.push({ runner: "pytest", executed, notRun, detail: parts.join(", ") || "no tests ran" });
    }
  }
  return found;
}

/**
 * Why a check that exited 0 proves nothing, or null when it ran a test or its output is not a test summary. Several summaries
 * (`a && b`, a workspace run) are added up: one mistyped filter beside a real run still leaves tests that ran.
 */
export function noTestRanReason(output: string): string | null {
  const summaries = testSummaries(output);
  if (!summaries.length || summaries.some((summary) => summary.executed > 0)) return null;
  const detail = [...new Set(summaries.map((summary) => summary.detail).filter(Boolean))].join("; ") || "no test was counted";
  return `the check exited 0 but ran no test: ${detail} (${summaries[0]!.runner}) — the filter, file or test name matches nothing, or every test is skipped; a skipped, todo or pending test does not count, so fix the command or the test until at least one test runs`;
}
