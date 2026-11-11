import { stripAnsi } from "@lane-pilot/kit";
import type { FailingTest } from "../gate-output";


const TIMEOUT_ERROR_PATTERN = /(?:Test timed out in|Hook timed out in|\bTimeout\b|\btimed out\b)/i;

/**
 * Returns true if every failing test was caused exclusively by a timeout (e.g. machine load).
 * Returns false if there are no failing tests or if any test failed with non-timeout errors (e.g. assertion).
 */
export function allFailuresAreTimeouts(output: string, failingTests: readonly FailingTest[]): boolean {
  if (!failingTests.length) return false;
  const clean = stripAnsi(output);
  const lines = clean.split("\n");

  // If there are standard assertion / syntax / type errors anywhere in output, it's not all timeouts
  if (/\bAssertionError\b|\bexpected\s+.+\s+to\b|\berror TS\d+:/.test(clean)) {
    return false;
  }

  // Find sections or errors per failing test
  // Map files to whether a timeout was seen for that file
  const testFiles = new Set(failingTests.map((t) => t.file));
  const timeoutsByFile = new Set<string>();

  // In vitest / jest output:
  // e.g. FAIL tests/foo.test.ts > suite > test
  // Error: Test timed out in 5000ms.
  // or ❯ tests/foo.test.ts:24:5
  // or blocks per file. Let's associate lines with the current failing file being reported.
  let currentFile: string | null = null;

  for (const line of lines) {
    for (const file of testFiles) {
      if (line.includes(file)) {
        currentFile = file;
        break;
      }
    }

    if (TIMEOUT_ERROR_PATTERN.test(line)) {
      if (currentFile) {
        timeoutsByFile.add(currentFile);
      }
    }
  }

  // If not every file was associated via block tracking, check if global output has timeout
  // and each file is mentioned with a timeout or all errors in output are timeouts.
  if (timeoutsByFile.size === testFiles.size) {
    return true;
  }

  // Also handle case where test headers and errors appear in distinct structures:
  // If the output contains TIMEOUT_ERROR_PATTERN and no other failure keywords (AssertionError, etc.)
  const hasTimeout = TIMEOUT_ERROR_PATTERN.test(clean);
  const hasAssertionOrOtherFail = /\bAssertionError\b|\bExpected:|\bReceived:|\bexpect\(|\bassert\b/i.test(clean);

  if (hasTimeout && !hasAssertionOrOtherFail) {
    return true;
  }

  return false;
}

export function buildRecheckGateCommand(gateCommand: string, failingFiles: readonly string[]): string | null {
  // A detected `npm test` / `pytest -q` used to re-run the whole suite after an all-timeouts red (grill 2026-10-29 F-007): the files go
  // after `--` to a package script (vitest, jest, mocha and node --test all take them) and straight to pytest. A runner this cannot
  // narrow (`make check`, `python3 -I scripts/studio_test.py`) gets no encore at all: null, and the timeouts stand as the verdict.
  const isVitestOrJest = /(?:^|[;&|]\s*)(?:npx\s+)?(?:vitest|jest)(?:\s+run)?(?:\s+|$)/i.test(gateCommand);
  const isPytest = /(?:^|[;&|]\s*)(?:python3?\s+-m\s+)?pytest(?:\s|$)/i.test(gateCommand);
  const isPackageScript = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?test\s*$/i.test(gateCommand.trim());
  if (!failingFiles.length || !(isVitestOrJest || isPytest || isPackageScript)) return null;
  const uniqueFiles = [...new Set(failingFiles)];
  return isPackageScript ? `${gateCommand.trim()} -- ${uniqueFiles.join(" ")}` : `${gateCommand} ${uniqueFiles.join(" ")}`;
}
