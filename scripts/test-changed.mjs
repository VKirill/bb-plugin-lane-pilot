#!/usr/bin/env node
// Everyday check: the tests next to what you changed, not the whole suite (that stays the gate for a deploy: npm test / scripts/test-full.sh).
//
//   npm run test:changed              tests that import a changed file directly, tests named after it, changed test files,
//                                     and tests that literally name a changed non-code file (a workflow JSON, a runner
//                                     script, a config); for a wide file (imported by more than 15 tests) only the
//                                     importers that name an identifier the change touched
//   npm run test:changed -- --graph   every test that reaches a changed module through any import chain (vitest --changed;
//                                     the plugin's barrels connect most files, so a change in a shared file selects half
//                                     the suite), plus literal-named owners vitest's graph cannot see
//   npm run test:changed -- <ref>     compare with another base; other flags go to vitest
//
// Changes are uncommitted edits against HEAD; with a clean tree, the commits of this branch against main — and on main
// itself (where merge-base is HEAD) the commits since origin/main or the last commit. Deletions count: a removed
// module still selects the tests that import it. Docs and media are the only provable non-inputs; any other changed
// file that maps to no suite is reported as needing scope with a nonzero exit — never as "nothing to run".
// Writes no deploy receipt.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
// A probe may fail (a default-base candidate ref that does not exist): it reads as empty. A read the selection rests on
// (status, the base itself, the diff, the untracked list) must not: a failed one is no evidence of «no changes», so the
// script stops nonzero instead of reporting «nothing to run».
const probe = (...args) => { try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const git = (...args) => {
  try { return execFileSync("git", args, { encoding: "utf8" }).trim(); }
  catch (cause) {
    console.error(`test:changed: git ${args.join(" ")} failed (${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}); the change set is unknown, nothing is selected`);
    process.exit(1);
  }
};

const argv = process.argv.slice(2);
const graph = argv.includes("--graph");
// --list: print the selection and run nothing — in graph mode that is `vitest list`, which collects but never runs.
const listOnly = argv.includes("--list");
let rest = argv.filter((arg) => arg !== "--graph" && arg !== "--list");
let base = rest[0] && !rest[0].startsWith("-") ? rest.shift() : "";

// The base the diff runs against: uncommitted edits vs HEAD on a dirty tree; on a clean tree the branch's commits
// against main. On main itself merge-base(HEAD, main) is HEAD — the change is then the commits since origin/main,
// or just the last commit when there is no upstream to compare with.
function defaultBase() {
  if (git("status", "--porcelain")) return "HEAD";
  const head = git("rev-parse", "HEAD");
  for (const ref of ["main", "origin/main"]) {
    const mergeBase = probe("merge-base", "HEAD", ref);
    if (mergeBase && mergeBase !== head) return mergeBase;
  }
  return probe("rev-parse", "--verify", "--quiet", "HEAD~1") ? "HEAD~1" : "HEAD";
}
if (!base) base = defaultBase();
console.log(`test:changed: ${graph ? "dependency graph" : "direct importers"} of changes since ${git("rev-parse", "--short", base)}`);

const TEST = /\.test\.tsx?$/;
const SOURCE = /\.(ts|tsx)$/;
// Documentation and binary media/fonts/archives are the only changes that can never be a suite input. Everything
// else — code, JSON, shell, workflow and config files — must map to a suite or be reported as needing scope.
const INERT = /\.(md|markdown|rst|txt|adoc|org|png|jpe?g|gif|bmp|webp|ico|pdf|zip|gz|tgz|mp4|mp3|wav|webm|mov|avi|mkv|woff2?|ttf|otf|eot)$/i;
// .agents/ is the drill-evidence store: hundreds of untracked JSON logs that are never suite input, and listing
// them would make the literal-owner scan below quadratic. Everything else untracked still counts.
const changed = [...new Set([
  ...git("diff", "--name-only", base).split("\n"),
  ...git("ls-files", "--others", "--exclude-standard").split("\n"),
])].filter((file) => file && !file.startsWith(".agents/"));

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
const texts = new Map(testFiles.map((test) => [test, readFileSync(test, "utf8")]));

const onDisk = (file) => existsSync(file);
// A test that literally names the changed file — its repo path first, then its basename — is a known owner the
// import graph cannot see (spawned scripts, readFileSync fixtures, workflow JSON). Path beats basename so same-named
// files in different rooms do not silently share ownership; the printed reason keeps the match explainable.
const literalOwners = (file) => {
  const rel = file.replace(/\\/g, "/");
  const byPath = testFiles.filter((test) => texts.get(test).includes(rel));
  if (byPath.length) return { tests: byPath, via: rel };
  const name = basename(file);
  const byName = testFiles.filter((test) => texts.get(test).includes(name));
  if (byName.length) return { tests: byName, via: name };
  const wf = /^workflows\/([^/]+)\.json$/.exec(rel);
  if (wf) {
    const wfId = wf[1];
    const byWfId = testFiles.filter((test) => texts.get(test).includes(`"${wfId}"`) || texts.get(test).includes(`'${wfId}'`));
    if (byWfId.length) return { tests: byWfId, via: wfId };
  }
  return { tests: [], via: name };
};

const selected = new Set();
const sources = [];
const literalSelected = new Set();
const unsupported = [];
for (const file of changed) {
  if (TEST.test(file)) {
    // A deleted test file has nothing left to run; a changed one selects itself.
    if (onDisk(file)) { selected.add(file); console.log(`test:changed: ${file}: changed test file`); }
    continue;
  }
  if (SOURCE.test(file)) sources.push(file); // importer mapping below; deletions included on purpose
  const lit = literalOwners(file);
  if (lit.tests.length) {
    for (const test of lit.tests) literalSelected.add(test);
    console.log(`test:changed: ${file}: ${lit.tests.length} test${lit.tests.length === 1 ? "" : "s"} name ${lit.via}`);
  }
  if (!SOURCE.test(file) && !lit.tests.length && !INERT.test(file)) unsupported.push(file);
}

// The identifiers a change touches in one file: declarations on changed lines and in the hunk headers git gives (the enclosing
// top-level declaration), object keys on changed lines (an i18n key, an RPC handler), `id: "…"` values (a role row). Short names
// (`en`, `id`) say nothing and are left out.
// Only top-level declarations count: a local `const limit` inside a function names nothing a test would.
const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const REEXPORT = /^export\s+(?:type\s+)?\{([^}]*)\}/;
const REEXPORT_ITEM = /^\s{1,6}(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*,?\s*$/;
const KEY = /^\s{0,6}["']?([A-Za-z_$][\w$-]{7,})["']?\s*:/;
const ID_VALUE = /\bid:\s*["']([\w.:-]+)["']/g;
function extractReexportSpecs(specList, target) {
  for (const part of specList.split(",")) {
    const m = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
    if (m) target.add(m[2] || m[1]);
  }
}
function touchedIdentifiers(file) {
  const names = new Set();
  const reexportMinus = new Set(), reexportPlus = new Set();
  let inExportBlock = false;
  for (const line of git("diff", "-U0", base, "--", file).split("\n")) {
    if (line.startsWith("@@")) {
      const header = line.replace(/^@@[^@]*@@\s?/, "");
      inExportBlock = /^export\s+(?:type\s+)?\{/.test(header) && !header.includes("}");
      for (const match of header.matchAll(DECL)) names.add(match[1]);
      continue;
    }
    if (!/^[+-](?![+-])/.test(line)) continue;
    const sign = line[0], body = line.slice(1);
    const bucket = sign === "-" ? reexportMinus : reexportPlus;
    const reexp = REEXPORT.exec(body);
    if (reexp) {
      extractReexportSpecs(reexp[1], bucket);
      inExportBlock = !body.includes("}");
      continue;
    }
    if (inExportBlock) {
      if (body.includes("}")) { inExportBlock = false; continue; }
      const item = REEXPORT_ITEM.exec(body);
      if (item) { bucket.add(item[2] || item[1]); continue; }
    }
    for (const match of body.matchAll(DECL)) names.add(match[1]);
    const key = KEY.exec(body);
    if (key) names.add(key[1]);
    for (const match of body.matchAll(ID_VALUE)) names.add(match[1]);
  }
  for (const sym of reexportPlus) if (!reexportMinus.has(sym)) names.add(sym);
  for (const sym of reexportMinus) if (!reexportPlus.has(sym)) names.add(sym);
  return [...names].filter((name) => name.length >= 4);
}
const WIDE = 15;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A test file that changed because a helper beside it changed (tests/ui-harness.tsx, tests/workflow/chain-helpers.ts ...) is found like a source file.
const stems = sources.map((file) => {
  const name = basename(file).replace(/\.(ts|tsx)$/, "");
  const stem = name === "index" ? basename(dirname(file)) : name;
  return { file, stem, pattern: new RegExp(`from\\s+["'][^"']*/${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/index)?(\\.[a-z]+)?["']|import\\(["'][^"']*/${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/index)?["']`) };
});
const ownedSources = new Set();
for (const { file, stem, pattern } of stems) {
  const importers = testFiles.filter((test) => basename(test).includes(stem) || pattern.test(texts.get(test)));
  const names = importers.length > WIDE ? touchedIdentifiers(file) : [];
  if (!names.length) {
    if (importers.length) console.log(`test:changed: ${file}: ${importers.length} importer${importers.length === 1 ? "" : "s"}`);
    for (const test of importers) { selected.add(test); ownedSources.add(file); }
    continue;
  }
  const named = new RegExp(`\\b(?:${names.map(escape).join("|")})\\b`);
  const kept = importers.filter((test) => basename(test).includes(stem) || named.test(texts.get(test)));
  console.log(`test:changed: ${file} is imported by ${importers.length} tests; ${kept.length} name what changed (${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""})`);
  for (const test of kept) { selected.add(test); ownedSources.add(file); }
}
// Tests of a package are the package's own.
for (const file of sources) {
  const match = /^packages\/([^/]+)\//.exec(file);
  if (match) for (const test of testFiles) if (test.startsWith(`packages/${match[1]}/tests/`)) { selected.add(test); ownedSources.add(file); }
}
// A source file counts as supported when importers, literal names or its package suite own it.
for (const file of sources) {
  const lit = literalOwners(file);
  if (lit.tests.length) ownedSources.add(file);
  if (!ownedSources.has(file) && !unsupported.includes(file)) unsupported.push(file);
}
for (const test of literalSelected) selected.add(test);

const moduleChanged = changed.some((file) => SOURCE.test(file) || (TEST.test(file) && onDisk(file)));

if (unsupported.length) {
  console.error(`test:changed: ${unsupported.length} changed file${unsupported.length === 1 ? "" : "s"} ha${unsupported.length === 1 ? "s" : "ve"} no known owning suite — needs scope: ${unsupported.join(", ")}`);
}

const finish = (status) => {
  // Green selection with unmapped changes is not a clean bill: needs-scope stays nonzero.
  if (status === 0 && unsupported.length) return 2;
  return status;
};

if (graph) {
  // vitest --changed sees module imports only; literal-named owners run as explicit files afterwards.
  let status = 0;
  if (moduleChanged) {
    const mode = listOnly ? "list" : "run";
    const run = spawnSync("npx", ["vitest", mode, "--changed", base, "--passWithNoTests", ...rest], { stdio: "inherit" });
    status = run.status ?? 1;
    if (status !== 0) process.exit(finish(status));
  }
  const literal = [...literalSelected].sort();
  if (literal.length) {
    if (listOnly) {
      console.log("test:changed: literal-referenced suites (not module-imported):");
      for (const test of literal) console.log(test);
    } else {
      const run = spawnSync("npx", ["vitest", "run", ...literal, ...rest], { stdio: "inherit" });
      status = run.status ?? 1;
    }
  }
  if (status === 0 && !moduleChanged && !literal.length && !selected.size && !unsupported.length) {
    console.log("test:changed: nothing to run.");
  }
  process.exit(finish(status));
}

if (!selected.size) {
  if (unsupported.length) process.exit(finish(2));
  console.log("test:changed: nothing to run.");
  process.exit(0);
}
console.log(`test:changed: ${selected.size} test file${selected.size === 1 ? "" : "s"}`);
if (listOnly) { for (const test of [...selected].sort()) console.log(test); process.exit(finish(0)); }
const run = spawnSync("npx", ["vitest", "run", ...selected, ...rest], { stdio: "inherit" });
process.exit(finish(run.status ?? 1));
