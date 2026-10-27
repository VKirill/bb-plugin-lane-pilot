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
  runner: "vitest" | "jest" | "node" | "pytest" | "studio";
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
    // A Roblox Studio test runner's report (Vampirism Fire studio_test.py): `12 checks, 0 failed`; executed checks are all N.
    const studio = /^(\d+)\s+checks?,\s+(\d+)\s+failed$/.exec(line.trim());
    if (studio) { found.push({ runner: "studio", executed: Number(studio[1]), notRun: 0, detail: "0 checks" }); continue; }
    // pytest's last line: `===== 3 passed, 1 skipped in 0.12s =====`, `1 passed, 4 deselected in 0.02s`, `no tests ran in 0.01s`.
    const pytest = /^(?:=+\s*)?((?:\d+\s+(?:passed|failed|skipped|deselected|xfailed|xpassed|errors?|warnings?|rerun)(?:,\s*)?)+|no tests ran)\s+in\s+\d+(?:\.\d+)?s\b/i.exec(line);
    if (pytest) {
      const { executed, notRun, parts } = countsOf(pytest[1]!);
      found.push({ runner: "pytest", executed, notRun, detail: parts.join(", ") || "no tests ran" });
    }
  }
  return found;
}

/** Splits a shell command at top-level `&&`, `;` and newlines; quoted text stays whole. */
function shellSegments(command: string): string[] {
  const parts: string[] = [];
  let current = "", quote = "";
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (quote) { current += char; if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if ((char === "&" && command[at + 1] === "&") || char === ";" || char === "\n") { if (char === "&") at++; parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const RUNNER_SEGMENT = /\b(?:vitest|jest|pytest|py\.test|mocha|playwright)\b|\bnode\b[^|]*--test\b|\b\w*test\w*\.(?:py|mjs|cjs|js|ts|sh)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:go|cargo) test\b/i;

/**
 * How many separate test runs a command names: chained runners (`vitest -t A && vitest -t B`, `a.py; b.py`) and a `for m in A B` loop
 * around one (one run per item). One runner that prints several summaries (a workspace run) is still 1.
 */
export function namedRuns(command: string): number {
  let runs = 0, loop = 1;
  for (const segment of shellSegments(command)) {
    const each = /^for\s+\S+\s+in\s+(.+?)(?:\s+do\b.*)?$/.exec(segment);
    if (each) { loop = each[1]!.split(/\s+/).filter(Boolean).length; const inline = /\bdo\s+(.+)$/.exec(segment); if (inline && RUNNER_SEGMENT.test(inline[1]!)) runs += loop; continue; }
    if (/^done\b/.test(segment)) { loop = 1; continue; }
    if (RUNNER_SEGMENT.test(segment.replace(/^do\b/, ""))) runs += loop;
  }
  return runs;
}

/**
 * Why a check that exited 0 proves nothing, or null when it ran a test or its output is not a test summary. Several summaries
 * of one command (a workspace run) are added up: one mistyped filter beside a real run still leaves tests that ran. When the
 * command names several runs itself (`namedRuns` >= 2) and the output has one summary per run, each of them must have run a test:
 * `3 checks, 0 failed` then `0 checks, 0 failed` is an empty scenario hidden by its neighbour (Astra's recheck, 2026-10-27).
 */
export function noTestRanReason(output: string, command?: string): string | null {
  const summaries = testSummaries(output);
  if (!summaries.length) return null;
  const named = command ? namedRuns(command) : 0;
  const empty = named >= 2 && summaries.length === named ? summaries.filter((summary) => summary.executed === 0) : [];
  if (summaries.some((summary) => summary.executed > 0) && !empty.length) return null;
  const shown = empty.length ? empty : summaries;
  const detail = [...new Set(shown.map((summary) => summary.detail).filter(Boolean))].join("; ") || "no test was counted";
  const which = empty.length ? `${empty.length} of its ${named} runs ` : "";
  return `the check exited 0 but ${which}ran no test: ${detail} (${shown[0]!.runner}) — the filter, file or test name matches nothing, or every test is skipped; a skipped, todo or pending test does not count, so fix the command or the test until at least one test runs`;
}

/** A sandbox's refusal of a tool's own files: the command did not run what it was asked to. */
export const SANDBOX_DENIAL=/couldn't create cache file|Operation not permitted/i;

/**
 * Why a re-run that exited 0 still proves nothing, or null. Vampirism Fire 2026-10-24: `studio_test.py` failed, then «passed»
 * on the re-run printing only the macOS python3 shim's «couldn't create cache file (Operation not permitted)», no report; that
 * empty green was accepted as flaky. A re-run counts only when it shows the check ran: it prints a test/check summary, or it
 * is not a command known to print one (the first run did not) and shows no sandbox refusal.
 */
export function hollowRerun(first:{stdout?:string;stderr?:string},again:{stdout?:string;stderr?:string}):string|null {
  const printed=(run:{stdout?:string;stderr?:string})=>`${run.stdout??""}\n${run.stderr??""}`;
  if(testSummaries(printed(again)).length) return null;
  if(testSummaries(printed(first)).length) return "printed no test or check summary, which this command printed on its first run";
  return SANDBOX_DENIAL.test(printed(again)) ? "printed only a sandbox refusal and no test or check summary" : null;
}

