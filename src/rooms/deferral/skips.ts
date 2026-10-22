import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Skipped tests as deferrals (SMA rule 5: `it.todo` without a term is a silent hole). Every `skip`, `todo`, `skipIf`, `xit`, `xdescribe`
 * in the test folders must carry `// deferral:<id>` on its own line or on the line above, and the id must name an entry of the register.
 * The lint test (tests/deferral-skips.test.ts) checks the comment and the seeded ids offline; the deploy drill sends every id found
 * in the repository to the register, which refuses ids it does not hold or that are closed.
 */
export type SkipSite = { file: string; line: number; code: string; deferralId: string | null };

const SKIP = /\b(?:it|test|describe)\.(?:skip|todo|skipIf)\b|\bx(?:it|test|describe)\s*\(/;
const MARK = /\/\/\s*deferral:(dfr_[A-Za-z0-9_]+)/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".claude", ".bb", "coverage"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (/\.(?:ts|tsx|mts)$/.test(name)) yield path;
  }
}

/** The test folders of the repository: `tests/` and every `packages/<name>/tests/`. */
export function testRoots(root: string): string[] {
  const roots = [join(root, "tests")];
  const packages = join(root, "packages");
  if (existsSync(packages)) for (const name of readdirSync(packages)) roots.push(join(packages, name, "tests"));
  return roots.filter((dir) => existsSync(dir));
}

export function scanSkips(root: string): SkipSite[] {
  const sites: SkipSite[] = [];
  for (const dir of testRoots(root)) {
    for (const path of walk(dir)) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((text, index) => {
        if (COMMENT_LINE.test(text) || !SKIP.test(text)) return;
        const own = MARK.exec(text) ?? (COMMENT_LINE.test(lines[index - 1] ?? "") ? MARK.exec(lines[index - 1]!) : null);
        sites.push({ file: relative(root, path), line: index + 1, code: text.trim().slice(0, 120), deferralId: own?.[1] ?? null });
      });
    }
  }
  return sites;
}

/** Every `deferral:<id>` written anywhere in the test folders (what the drill sends to the register). */
export function citedDeferralIds(root: string): string[] {
  const ids = new Set<string>();
  for (const dir of testRoots(root)) {
    for (const path of walk(dir)) for (const hit of readFileSync(path, "utf8").matchAll(new RegExp(MARK.source, "g"))) ids.add(hit[1]!);
  }
  return [...ids].sort();
}
