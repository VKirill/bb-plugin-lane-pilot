#!/usr/bin/env node
// Everyday check: the tests next to what you changed, not the whole suite (that stays the gate for a deploy: npm test / scripts/test-full.sh).
//
//   npm run test:changed              tests that import a changed file directly, tests named after it, and changed test files
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
let rest = argv.filter((arg) => arg !== "--graph");
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
if (stems.length) {
  for (const test of testFiles) {
    const text = readFileSync(test, "utf8");
    for (const { stem, pattern } of stems) {
      if (basename(test).includes(stem) || pattern.test(text)) { selected.add(test); break; }
    }
  }
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
const run = spawnSync("npx", ["vitest", "run", ...selected, ...rest], { stdio: "inherit" });
process.exit(run.status ?? 1);
