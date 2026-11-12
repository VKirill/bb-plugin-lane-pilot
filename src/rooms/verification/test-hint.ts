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

export type TestHint = { file: string; reason: "changed" | "name" | "import" };

/**
 * The ranked test hint for a change: directly named and import-linked tests (found in code). Only the hint — never the
 * contract.
 */
export async function suggestTests(
  input: {
    changedFiles: string[];
    repoFiles: string[];
    readFile?: (path: string) => Promise<string | null>;
    limit?: number;
  },
): Promise<TestHint[]> {
  const tests = input.repoFiles.filter((file) => TEST_FILE_RE.test(file));
  const changed = input.changedFiles.filter((file) => !TEST_FILE_RE.test(file));
  if (!tests.length || !changed.length) return [];
  const hint = new Map<string, TestHint>();
  for (const file of input.changedFiles) if (TEST_FILE_RE.test(file) && tests.includes(file)) hint.set(file, { file, reason: "changed" });
  for (const file of directTestMatches(input.changedFiles, tests)) if (!hint.has(file)) hint.set(file, { file, reason: "name" });
  if (input.readFile) for (const file of await importLinkedTests(changed, tests.slice(0, 120), input.readFile)) if (!hint.has(file)) hint.set(file, { file, reason: "import" });
  return [...hint.values()].slice(0, input.limit ?? 10);
}

/** The one line the PM sees; empty when nothing was linked or picked. */
export const testHintLine = (hint: readonly TestHint[]): string =>
  hint.length ? `These ${hint.length} test file${hint.length === 1 ? "" : "s"} cover the change — consider them for the verification commands: ${hint.map((row) => row.file).join(", ")}` : "";
