import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The owner, 2026-11-11: «раскладывать по своим домикам, а не создавать огроменные небоскрёбы».
 * A source file of the plugin holds at most LIMIT lines. The files that were over it when the rule came are in
 * file-size.json with a ceiling (their size then, rounded up to a hundred): a ceiling is never raised and a new file
 * gets none. After a split run `UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture` to lower the ceilings.
 */
const ROOT = join(__dirname, "../..");
const BASELINE_PATH = join(__dirname, "file-size.json");
const LIMIT = 500;

/** Not code a person splits: generated sources, dictionaries, and the append-only migration list. */
const EXEMPT = new Set([
  "src/rooms/contracts/native-hook-sources.ts", "src/rooms/contracts/native-opencode-sources.ts", "src/rooms/contracts/session-hook-source.ts",
  "src/rooms/sma-map/contracts.ts", "src/rooms/sma-map/entries.ts", "src/rooms/sma-map/graph.ts",
  "packages/i18n/src/i18n.ts", "packages/i18n/src/i18n-fields.ts",
  "src/rooms/migrations.ts",
]);

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return ["node_modules", "tests", "dist"].includes(name) ? [] : walk(path);
  return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [path] : [];
});
const ceilingOf = (lines: number) => Math.ceil(lines / 100) * 100;

describe("file size", () => {
  it(`no source file is over ${LIMIT} lines, and the ones that were do not grow`, () => {
    const files = [...walk(join(ROOT, "src/rooms")), ...walk(join(ROOT, "packages")), ...["server.ts", "host.ts", "app.tsx"].map((name) => join(ROOT, name))];
    const over = new Map(files.map((path) => [relative(ROOT, path), readFileSync(path, "utf8").split("\n").length] as const)
      .filter(([path, lines]) => lines > LIMIT && !EXEMPT.has(path)));
    const first = !existsSync(BASELINE_PATH);
    let baseline = first ? {} : JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;
    if (process.env.UPDATE_ARCH_BASELINE === "1" || first) {
      // Lowers only: a file over the limit that the baseline does not name stays a failure (the first write names them all).
      baseline = Object.fromEntries([...over].filter(([path]) => first || path in baseline)
        .map(([path, lines]) => [path, Math.min(baseline[path] ?? Infinity, ceilingOf(lines))] as const).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 1) + "\n");
    }
    const fresh = [...over].filter(([path]) => !(path in baseline)).map(([path, lines]) => `${path}: ${lines} lines`);
    expect(fresh, `a file over ${LIMIT} lines: split it by responsibility (one module, one job)`).toEqual([]);
    const grown = [...over].filter(([path, lines]) => path in baseline && lines > baseline[path]!).map(([path, lines]) => `${path}: ${lines} lines, ceiling ${baseline[path]}`);
    expect(grown, "a big file grew past its ceiling: move the new code into its own module").toEqual([]);
    const stale = Object.keys(baseline).filter((path) => !over.has(path) || ceilingOf(over.get(path)!) < baseline[path]!);
    expect(stale, "these files shrank: run UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture to lower their ceilings").toEqual([]);
  });
});
