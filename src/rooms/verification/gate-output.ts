/**
 * Reading a gate run's output: which test files failed (and in which turbo package), and which turbo tasks were cache hits.
 * Pure text functions, shared by the hub (the culprit search) and the host (the baseline run of the failing files).
 */

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/** `@scope/pkg:test: ` or `pkg:test:unit: ` in front of a line turbo relays from a package's task. */
const TURBO_PREFIX = /^((?:@[\w.-]+\/)?[\w.-]+):([\w.-]+(?::[\w.-]+)*): ?/;
const FILE = "[\\w./@+-]+";
const TEST_EXT = "(?:test|spec)\\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)";

export type FailingTest = {
  /** The path as the runner printed it: relative to the package that ran it. */
  file: string;
  /** The turbo package whose task printed it (`@scope/pkg`), when the output is turbo's. */
  workspacePackage: string | null;
};

/**
 * The files a red run names as failed. Only lines that say «failed» count (vitest/jest `FAIL`, vitest's `❯ file (3 tests | 1
 * failed)` and failure stack frames, tsc errors): the file names of passing tests and of console output (`stdout | file > test`)
 * are not failures. Only when no such line is there, a test file named anywhere on a line that does not say it passed is taken.
 */
export function extractFailingTests(output: string): FailingTest[] {
  const found = new Map<string, FailingTest>();
  const loose: FailingTest[] = [];
  const add = (into: Map<string, FailingTest> | FailingTest[], file: string, workspacePackage: string | null) => {
    const entry = { file: file.trim().replace(/^\.\//, ""), workspacePackage };
    if (Array.isArray(into)) into.push(entry);
    else into.set(`${workspacePackage ?? ""}\u0000${entry.file}`, entry);
  };
  for (const raw of stripAnsi(output).split("\n")) {
    const prefix = raw.match(TURBO_PREFIX);
    const line = prefix ? raw.slice(prefix[0].length) : raw;
    const workspacePackage = prefix?.[1] ?? null;
    const tsc = line.match(new RegExp(`^(${FILE}\\.(?:ts|tsx|js|jsx|mjs|cjs)):(\\d+):(\\d+)\\s+-\\s+error`));
    if (tsc?.[1]) { add(found, tsc[1], workspacePackage); continue; }
    const strong = line.match(new RegExp(`(?:FAIL|✕|×|❯)\\s+(${FILE}\\.${TEST_EXT})`));
    if (strong?.[1]) { add(found, strong[1], workspacePackage); continue; }
    if (/[✓✔]|\bPASS\b|^\s*(?:stdout|stderr) \|/.test(line)) continue;
    const named = line.match(new RegExp(`\\b(${FILE}\\.${TEST_EXT})\\b`));
    if (named?.[1]) add(loose, named[1], workspacePackage);
  }
  if (found.size) return [...found.values()];
  const unique = new Map<string, FailingTest>();
  for (const entry of loose) unique.set(`${entry.workspacePackage ?? ""}\u0000${entry.file}`, entry);
  return [...unique.values()];
}

export const extractFailingFiles = (output: string): string[] => [...new Set(extractFailingTests(output).map((test) => test.file))];

export type CacheReport = {
  /** `pkg#task` of every task turbo answered from its cache. */
  hits: string[];
  /** turbo's own «Cached:  49 cached, 73 total» line. */
  summary: string | null;
};

/** The turbo tasks whose result was replayed from the cache instead of run (the output says «cache hit»). */
export function extractCacheHits(output: string): CacheReport {
  const hits = new Set<string>();
  let summary: string | null = null;
  for (const raw of stripAnsi(output).split("\n")) {
    const hit = raw.match(/^((?:@[\w.-]+\/)?[\w.-]+):([\w.-]+(?::[\w.-]+)*): cache hit\b/);
    if (hit) hits.add(`${hit[1]}#${hit[2]}`);
    const total = raw.match(/^\s*Cached:\s+(\d+ cached, \d+ total)/);
    if (total) summary = total[1]!;
  }
  return { hits: [...hits], summary };
}

/** One sentence for the PM: which workspaces were cache hits, empty when none was. */
export function cacheHitsNote(report: CacheReport, max = 12): string {
  if (!report.hits.length) return "";
  const shown = report.hits.slice(0, max).join(", ");
  const rest = report.hits.length > max ? ` and ${report.hits.length - max} more` : "";
  return `Cache hits (turbo replayed these results instead of running them): ${shown}${rest}${report.summary ? ` (${report.summary})` : ""}.`;
}
