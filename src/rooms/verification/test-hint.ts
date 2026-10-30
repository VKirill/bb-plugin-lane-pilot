import { defineJudgment, noul, noulOf, type Jev, type JudgeContext } from "@lane-pilot/jev";

/**
 * jgrep --tests for the PM: when a task's contract names the files it will change, the test files that cover them are
 * ranked and handed back as a hint («these N test files cover the change»). A hint only — the contract and its
 * verification commands never change on their own.
 */

export const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec|specs)\/|(\.|_)(test|spec|tst|test-d)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go|rb|exs)$|_spec\.rb$/;

const stem = (file: string): string => file.split("/").pop()!.replace(/[._-](test|spec|tst|test-d)\.[cm]?[jt]sx?$|^test_|\.[^.]+$/g, "").toLowerCase();

/** Tests whose name mirrors a changed file (foo.ts → foo.test.ts, test_foo.py): linked in code, never asked. */
export function directTestMatches(changedFiles: readonly string[], testFiles: readonly string[]): string[] {
  const stems = new Set(changedFiles.filter((file) => !TEST_FILE_RE.test(file)).map(stem));
  const changedTests = new Set(changedFiles.filter((file) => TEST_FILE_RE.test(file)));
  return testFiles.filter((file) => TEST_FILE_RE.test(file) && (changedTests.has(file) || stems.has(stem(file))));
}

/** Test files that import a changed file, read from their import lines (the static link jgrep uses before asking). */
export async function importLinkedTests(changedFiles: readonly string[], testFiles: readonly string[], readFile: (path: string) => Promise<string | null>): Promise<string[]> {
  const changed = new Set(changedFiles);
  const out: string[] = [];
  for (const file of testFiles) {
    const text = await readFile(file);
    if (!text) continue;
    for (const match of text.matchAll(/(?:import|from|require\()\s*["'`]([^"'`]+)["'`]/g)) {
      const spec = match[1]!;
      if (!spec.startsWith(".")) continue;
      const dir = file.split("/").slice(0, -1);
      for (const part of spec.split("/")) {
        if (part === "..") dir.pop();
        else if (part !== ".") dir.push(part);
      }
      const base = dir.join("/");
      for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js"]) {
        if (changed.has(base + ext)) { out.push(file); break; }
      }
      if (out[out.length - 1] === file) break;
    }
  }
  return out;
}

/** Imports plus test/describe names: enough for Jev to know what the file exercises. */
export function testSignature(text: string): string {
  const keep = /^\s*(export .+ from |import |from .+ import |const .+ = require\(|require\(|describe\(|it\(|test\(|it\.each|test\.each|context\(|scenario\()/;
  return text.split("\n").filter((line) => keep.test(line)).map((line) => line.trim().slice(0, 160)).slice(0, 60).join("\n");
}

export const TEST_PICK_ID = "verify.test_pick";
export type TestPickInput = { changedFiles: string[]; diffHead: string; tests: Array<{ file: string; signature: string }> };

export const testPickJudgment = defineJudgment<TestPickInput, boolean[]>({
  id: TEST_PICK_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({ changed_files: input.changedFiles.slice(0, 40), diff_head: input.diffHead.slice(0, 6_000) }),
  questions: (input) => Object.fromEntries(input.tests.slice(0, 40).map((test, index) => [`t${index + 1}`, noul(
    "Would the change in `changed_files`/`diff_head` plausibly affect what this test file exercises? Answer yes when it is worth running first.",
    { true: `relevant: ${test.file}\n${test.signature.slice(0, 400)}`, false: `not affected: ${test.file}` },
  )])),
  thresholds: { min_p: { default: 0.4, min: 0.05, max: 0.9, about: "least p(yes) for a test to make the hint; low, a missed test costs more than an extra line" } },
  decide: (answers, t, input) => ({
    decision: input.tests.slice(0, 40).map((_, index) => (noulOf(answers, `t${index + 1}`) ?? 0) >= t.min_p!),
  }),
  fallback: (input) => input.tests.map(() => false),
  describe: (decision) => `${decision.filter(Boolean).length}/${decision.length} picked`,
});

export type TestHint = { file: string; reason: "changed" | "name" | "import" | "jev" };

/**
 * The ranked test hint for a change: directly named and import-linked tests first (found in code), then the files Jev
 * marks relevant. Only the hint — never the contract.
 */
export async function suggestTests(
  jev: Jev | null,
  input: {
    changedFiles: string[];
    repoFiles: string[];
    diffHead?: string;
    readFile?: (path: string) => Promise<string | null>;
    limit?: number;
  },
  ctx: JudgeContext = {},
): Promise<TestHint[]> {
  const tests = input.repoFiles.filter((file) => TEST_FILE_RE.test(file));
  const changed = input.changedFiles.filter((file) => !TEST_FILE_RE.test(file));
  if (!tests.length || !changed.length) return [];
  const hint = new Map<string, TestHint>();
  for (const file of input.changedFiles) if (TEST_FILE_RE.test(file) && tests.includes(file)) hint.set(file, { file, reason: "changed" });
  for (const file of directTestMatches(input.changedFiles, tests)) if (!hint.has(file)) hint.set(file, { file, reason: "name" });
  if (input.readFile) for (const file of await importLinkedTests(changed, tests.slice(0, 120), input.readFile)) if (!hint.has(file)) hint.set(file, { file, reason: "import" });
  if (jev && jev.enabled(ctx.settings) && input.readFile) {
    const picked = tests.filter((file) => !hint.has(file)).slice(0, 40);
    const candidates = [] as Array<{ file: string; signature: string }>;
    for (const file of picked) candidates.push({ file, signature: testSignature((await input.readFile(file)) ?? "") });
    if (candidates.length) {
      const verdict = await jev.judge(testPickJudgment, { changedFiles: changed, diffHead: input.diffHead ?? "", tests: candidates }, ctx).catch(() => null);
      if (verdict?.by === "jev") candidates.forEach((test, index) => { if (verdict.decision[index] && !hint.has(test.file)) hint.set(test.file, { file: test.file, reason: "jev" }); });
    }
  }
  return [...hint.values()].slice(0, input.limit ?? 10);
}

/** The one line the PM sees; empty when nothing was linked or picked. */
export const testHintLine = (hint: readonly TestHint[]): string =>
  hint.length ? `These ${hint.length} test file${hint.length === 1 ? "" : "s"} cover the change — consider them for the verification commands: ${hint.map((row) => row.file).join(", ")}` : "";
