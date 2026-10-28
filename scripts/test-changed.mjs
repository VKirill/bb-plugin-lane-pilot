#!/usr/bin/env node
// Everyday check: the tests next to what you changed, not the whole suite (that stays the gate for a deploy: npm test / scripts/test-full.sh).
//
//   npm run test:changed              tests that import a changed file directly, tests named after it, and changed test files; for a
//                                     wide file (imported by more than 15 tests: i18n, storage, contracts, the role table) only the
//                                     importers that name an identifier the change touched (a function, a constant, a key)
//   npm run test:changed -- --graph   every test that reaches a changed file through any import chain (vitest --changed; the
//                                     plugin's barrels connect most files, so a change in a shared file selects half the suite)
//   npm run test:changed -- <ref>     compare with another base; other flags go to vitest
//
// Changes are uncommitted edits against HEAD; with a clean tree, the commits of this branch against main. Writes no deploy receipt.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const git = (...args) => { try { return execFileSync("git", args, { encoding: "utf8" }).trim(); } catch { return ""; } };

const argv = process.argv.slice(2);
const graph = argv.includes("--graph");
// --list: print the selection and run nothing
const listOnly = argv.includes("--list");
let rest = argv.filter((arg) => arg !== "--graph" && arg !== "--list");
let base = rest[0] && !rest[0].startsWith("-") ? rest.shift() : "";
if (!base) base = git("status", "--porcelain") ? "HEAD" : (git("merge-base", "HEAD", "main") || "HEAD");
console.log(`test:changed: ${graph ? "dependency graph" : "direct importers"} of changes since ${git("rev-parse", "--short", base)}`);

if (graph) {
  const run = spawnSync("npx", ["vitest", "run", "--changed", base, "--passWithNoTests", ...rest], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}

const changed = [...new Set([
  ...git("diff", "--name-only", base).split("\n"),
  ...git("ls-files", "--others", "--exclude-standard").split("\n"),
])].filter((file) => file && existsSync(file));

const TEST = /\.test\.tsx?$/;
const SOURCE = /\.(ts|tsx)$/;
const testFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (TEST.test(name)) testFiles.push(path);
  }
};
for (const dir of ["tests", "src", "packages"]) if (existsSync(dir)) walk(dir);

const selected = new Set();
const sources = [];
for (const file of changed) {
  if (TEST.test(file)) selected.add(file);
  else if (SOURCE.test(file)) sources.push(file);
}
// A test file that changed because a helper beside it changed (tests/ui-harness.tsx, tests/workflow/chain-helpers.ts ...) is found like a source file.
const stems = sources.map((file) => {
  const name = basename(file).replace(/\.(ts|tsx)$/, "");
  const stem = name === "index" ? basename(dirname(file)) : name;
  return { file, stem, pattern: new RegExp(`from\\s+["'][^"']*/${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/index)?(\\.[a-z]+)?["']|import\\(["'][^"']*/${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/index)?["']`) };
});
// The identifiers a change touches in one file: declarations on changed lines and in the hunk headers git gives (the enclosing
// top-level declaration), object keys on changed lines (an i18n key, an RPC handler), `id: "…"` values (a role row). Short names
// (`en`, `id`) say nothing and are left out.
// Only top-level declarations count: a local `const limit` inside a function names nothing a test would.
const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const KEY = /^\s{0,6}["']?([A-Za-z_$][\w$-]{7,})["']?\s*:/;
const ID_VALUE = /\bid:\s*["']([\w.:-]+)["']/g;
function touchedIdentifiers(file) {
  const names = new Set();
  for (const line of git("diff", "-U0", base, "--", file).split("\n")) {
    const header = line.startsWith("@@") ? line.replace(/^@@[^@]*@@\s?/, "") : null;
    const body = header ?? (/^[+-](?![+-])/.test(line) ? line.slice(1) : null);
    if (body === null) continue;
    for (const match of body.matchAll(DECL)) names.add(match[1]);
    if (header === null) {
      const key = KEY.exec(body);
      if (key) names.add(key[1]);
      for (const match of body.matchAll(ID_VALUE)) names.add(match[1]);
    }
  }
  return [...names].filter((name) => name.length >= 4);
}
const WIDE = 15;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const texts = new Map(testFiles.map((test) => [test, readFileSync(test, "utf8")]));
for (const { file, stem, pattern } of stems) {
  const importers = testFiles.filter((test) => basename(test).includes(stem) || pattern.test(texts.get(test)));
  const names = importers.length > WIDE ? touchedIdentifiers(file) : [];
  if (!names.length) {
    if (importers.length) console.log(`test:changed: ${file}: ${importers.length} importer${importers.length === 1 ? "" : "s"}`);
    for (const test of importers) selected.add(test);
    continue;
  }
  const named = new RegExp(`\\b(?:${names.map(escape).join("|")})\\b`);
  const kept = importers.filter((test) => basename(test).includes(stem) || named.test(texts.get(test)));
  console.log(`test:changed: ${file} is imported by ${importers.length} tests; ${kept.length} name what changed (${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""})`);
  for (const test of kept) selected.add(test);
}
// Tests of a package are the package's own.
for (const file of sources) {
  const match = /^packages\/([^/]+)\//.exec(file);
  if (match) for (const test of testFiles) if (test.startsWith(`packages/${match[1]}/tests/`)) selected.add(test);
}

if (!selected.size) {
  console.log(sources.length ? "test:changed: no test imports the changed files directly; try `npm run test:changed -- --graph`." : "test:changed: nothing to run.");
  process.exit(0);
}
console.log(`test:changed: ${selected.size} test file${selected.size === 1 ? "" : "s"}`);
if (listOnly) { for (const test of [...selected].sort()) console.log(test); process.exit(0); }
const run = spawnSync("npx", ["vitest", "run", ...selected, ...rest], { stdio: "inherit" });
process.exit(run.status ?? 1);
