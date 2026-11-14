// What scripts/sma-mutate.mjs runs and how it reads the result, per repository: this checkout and the core run vitest (the
// core from the package that holds the test: each has its own vitest.config.ts and node_modules), the Telegram plugin runs
// node:test through tsx from its root (`tsx --test`, the JUnit reporter). Both filter to the `[sma:<id>]` title. The verdicts
// are the same everywhere: an assertion failure kills; a TypeError/ReferenceError/import error/timeout is a crash.
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { SiblingName } from "./siblings";
import { SIBLINGS } from "./siblings";

export type TestRun = { ran: number; passed: number; assertion: string[]; crash: string[]; titles: string[] };
export const emptyRun = (): TestRun => ({ ran: 0, passed: 0, assertion: [], crash: [], titles: [] });

const CRASH = /^(?:TypeError|ReferenceError|SyntaxError|RangeError: Maximum call stack)|Cannot find module|Failed to load|Transform failed|failed to resolve import|Test timed out|is not a function|is not defined|ERR_MODULE_NOT_FOUND/m;
// A matcher refusing the received value (`.toMatch() expects to receive a string, but got object`) is the assertion
// judging the result, not the code under test crashing.
const MATCHER_REFUSAL = /^TypeError: \.?(?:to|not\.to)\w*\(\) expects/;
export const isCrash = (line: string) => !MATCHER_REFUSAL.test(line) && CRASH.test(line);

type VitestReport = { testResults?: Array<{ name: string; status?: string; message?: string; assertionResults?: Array<{ status: string; title: string; fullName?: string; failureMessages?: string[] }> }> };
/** A vitest `--reporter=json` report. `rel` names a file for the detail lines. */
export function readVitestReport(report: VitestReport, rel: (file: string) => string): TestRun {
  const run = emptyRun();
  for (const file of report.testResults ?? []) {
    const tests = (file.assertionResults ?? []).filter((test) => test.status === "passed" || test.status === "failed");
    if (file.status === "failed" && !tests.some((test) => test.status === "failed") && file.message) run.crash.push(`${rel(file.name)}: ${file.message.split("\n")[0]}`);
    for (const test of tests) {
      run.ran++;
      const title = test.fullName ?? test.title;
      run.titles.push(title);
      if (test.status === "passed") { run.passed++; continue; }
      const first = (test.failureMessages ?? []).join("\n").split("\n")[0]!;
      (isCrash(first) ? run.crash : run.assertion).push(`${title}: ${first.slice(0, 300)}`);
    }
  }
  return run;
}

const unescape = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
/** A node:test JUnit report. A test case named after its file (a file that failed to load) is a crash; a failure whose cause
 * is an AssertionError (or any non-crash error) is an assertion; a timeout or a cancelled test is a crash. */
export function readJunitReport(xml: string, rel: (file: string) => string): TestRun {
  const run = emptyRun();
  for (const hit of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = hit[1]!;
    const body = hit[3] ?? "";
    const name = unescape(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    const file = unescape(/\bfile="([^"]*)"/.exec(attrs)?.[1] ?? "");
    if (/<skipped\b/.test(body)) continue;
    const failure = /<failure\b([^>]*)>([\s\S]*?)<\/failure>/.exec(body);
    if (file && (name === rel(file) || name === file)) { if (failure) run.crash.push(`${name}: the file failed to load or run`); continue; }
    run.ran++;
    run.titles.push(name);
    if (!failure) { run.passed++; continue; }
    const type = /\btype="([^"]*)"/.exec(failure[1]!)?.[1] ?? "";
    const text = unescape(failure[2]!);
    const cause = /cause:\s*([^\n]*)/.exec(text)?.[1]?.trim() ?? unescape(/\bmessage="([^"]*)"/.exec(failure[1]!)?.[1] ?? "");
    const crashed = /testTimeoutFailure|cancelledByParent|hookFailure/.test(type) || (!/AssertionError|ERR_ASSERTION/.test(cause) && isCrash(cause));
    (crashed ? run.crash : run.assertion).push(`${name}: ${cause.slice(0, 300)}`);
  }
  return run;
}

export const mergeRuns = (runs: readonly TestRun[]): TestRun => runs.reduce((all, run) => ({ ran: all.ran + run.ran, passed: all.passed + run.passed, assertion: [...all.assertion, ...run.assertion], crash: [...all.crash, ...run.crash], titles: [...all.titles, ...run.titles] }), emptyRun());

export type Verdict = { result: "killed" | "survived" | "crash"; detail: string; ran?: string[] };
/** The verdict of the run with the mutation applied (the baseline was green). */
export function verdictOf(after: TestRun): Verdict {
  if (after.ran === 0 && after.crash.length) return { result: "crash", detail: after.crash.slice(0, 2).join(" | ") };
  if (after.assertion.length) return { result: "killed", detail: after.assertion[0]! };
  if (after.crash.length) return { result: "crash", detail: after.crash.slice(0, 2).join(" | ") };
  // The titles say WHICH tests ran: a survivor that ran only the old test (a new one not indexed), or one whose fixture is symmetric, shows here.
  return { result: "survived", detail: `${after.passed} of ${after.ran} test(s) still pass with the mutation`, ran: after.titles };
}

/** `missing`: the runner is not installed in the sibling checkout (the command is not run; the run is a crash saying so). */
export type TestCommand = { cmd: string; args: string[]; cwd: string; out: string; read: "vitest" | "junit"; missing?: string };
/** The sibling's own binary of a runner: `node_modules/.bin/<name>` at or above `from`, inside `root` — never one npx would fetch. */
export function siblingBin(root: string, from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const bin = join(dir, "node_modules", ".bin", name);
    if (existsSync(bin)) return bin;
    if (dir === root || relative(root, dir).startsWith("..") || dir === dirname(dir)) return null;
  }
}
const notInstalled = (sibling: SiblingName, name: string) => `${name} is not installed in the ${SIBLINGS[sibling].repo} checkout: run npm run sma:sibling -- setup ${sibling} (its dependencies)`;
const VITEST_CONFIGS = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs"];
/** The nearest folder at or above the test file (inside `root`) with a vitest config: where the core runs that test. */
export function vitestHome(root: string, file: string): string {
  for (let dir = dirname(join(root, file)); ; dir = dirname(dir)) {
    if (VITEST_CONFIGS.some((name) => existsSync(join(dir, name)))) return dir;
    if (dir === root || relative(root, dir).startsWith("..") || dir === dirname(dir)) return root;
  }
}

/** The commands that run `files` (relative to `root`) filtered by `pattern` for a repository: this one (sibling null) or a sibling. */
export function testCommands(sibling: SiblingName | null, root: string, files: readonly string[], pattern: string, outBase: string, config?: string): TestCommand[] {
  if (sibling && SIBLINGS[sibling].runner === "node-test") {
    const out = `${outBase}-junit.xml`;
    const tsx = siblingBin(root, root, "tsx");
    return [{ cmd: tsx ?? "tsx", args: ["--test", `--test-name-pattern=${pattern}`, "--test-reporter=junit", `--test-reporter-destination=${out}`, ...files], cwd: root, out, read: "junit", ...(tsx ? {} : { missing: notInstalled(sibling, "tsx") }) }];
  }
  const groups = new Map<string, string[]>();
  for (const file of files) { const home = sibling ? vitestHome(root, file) : root; groups.set(home, [...(groups.get(home) ?? []), relative(home, join(root, file))]); }
  return [...groups].map(([cwd, list], index) => {
    const out = `${outBase}-${index}.json`;
    const args = ["run", ...list, "-t", pattern, "--reporter=json", "--outputFile", out, ...(config ? ["--config", config] : [])];
    if (!sibling) return { cmd: "npx", args: ["vitest", ...args], cwd, out, read: "vitest" as const };
    const vitest = siblingBin(root, cwd, "vitest");
    return { cmd: vitest ?? "vitest", args, cwd, out, read: "vitest" as const, ...(vitest ? {} : { missing: notInstalled(sibling, "vitest") }) };
  });
}
