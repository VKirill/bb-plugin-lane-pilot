// Codemod: move files (git mv) and rewrite every import that points to them.
//   npx tsx scripts/refactor/move.ts scripts/refactor/steps/01-kit.json [--dry]
// The map is {"moves":[{"from":"src/hash.ts","to":"packages/kit/src/hash.ts","entry":"pure"?}], "dirs":[{"from":"src/jev/","to":"packages/jev/src/"}]}.
// - A file moved into packages/<p>/src/ is re-exported from the package index (`export * from "./name"`), or from
//   packages/<p>/src/<entry>.ts when "entry" is set (then importers use "@lane-pilot/<p>/<entry>").
// - Importers outside the package use the package name, importers inside it use relative paths.
// - Idempotent: a second run after the files are moved finds nothing to do.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { ROOT, buildGraph, posix as toPosix, roomOf, scanFile } from "./graph";

interface MoveEntry { from: string; to: string; entry?: string }
interface MoveMap { moves?: MoveEntry[]; dirs?: MoveEntry[] }

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const mapPath = args.find((a) => !a.startsWith("--"));
if (!mapPath) throw new Error("usage: move.ts <map.json> [--dry]");
const map: MoveMap = JSON.parse(readFileSync(join(ROOT, mapPath), "utf8"));

function walkAll(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkAll(rel));
    else out.push(rel);
  }
  return out;
}

const moves = new Map<string, { to: string; entry?: string }>();
for (const m of map.moves ?? []) {
  if (existsSync(join(ROOT, m.from))) moves.set(m.from, { to: m.to, entry: m.entry });
  else if (!existsSync(join(ROOT, m.to))) throw new Error(`neither ${m.from} nor ${m.to} exists`);
}
for (const d of map.dirs ?? []) {
  const from = d.from.replace(/\/?$/, "/");
  if (!existsSync(join(ROOT, from))) continue;
  for (const f of walkAll(from.slice(0, -1))) moves.set(f, { to: posix.join(d.to, f.slice(from.length)), entry: d.entry });
}
const moveTo = (file: string) => moves.get(file)?.to ?? file;

for (const [from, { to }] of moves) {
  if (existsSync(join(ROOT, to)) && from !== to) throw new Error(`target exists: ${to} (from ${from})`);
}

const graph = buildGraph();
const stripExt = (p: string) => p.replace(/\.(ts|tsx)$/, "").replace(/\/index$/, "");

function pkgOf(file: string): string | null {
  const m = /^packages\/([^/]+)\/src\//.exec(file);
  return m ? m[1]! : null;
}

/** Specifier that file `fromFile` (new location) should use for `target` (new location). */
function specFor(fromFile: string, target: string, entryOf: string | undefined, original: string): string {
  const tp = pkgOf(target);
  const fp = pkgOf(fromFile);
  if (tp && fp !== tp) {
    return entryOf ? `@lane-pilot/${tp}/${entryOf}` : `@lane-pilot/${tp}`;
  }
  let rel = toPosix(relative(dirname(fromFile), target));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  rel = /\.(json|css)$/.test(rel) ? rel : stripExt(rel);
  // keep an explicit "/index" when the original spelled it
  if (original.endsWith("/index") && !rel.endsWith("/index") && /\/index\.tsx?$/.test(target)) rel += "/index";
  return rel;
}

const edits = new Map<string, { start: number; end: number; text: string }[]>();
let rewritten = 0;
for (const file of graph.files) {
  const newFile = moveTo(file);
  for (const ref of graph.refs.get(file) ?? []) {
    if (!ref.to) continue;
    const m = moves.get(ref.to);
    const newTarget = m?.to ?? ref.to;
    if (newFile === file && !m) continue;
    // an `@lane-pilot/x` specifier of a file that did not move keeps working unless its target moved
    if (!ref.spec.startsWith(".") && !m) continue;
    // a package that is the target of an unchanged bare specifier from a moved file stays as is
    if (!ref.spec.startsWith(".") && newFile !== file && !m) continue;
    const spec = specFor(newFile, newTarget, m?.entry, ref.spec);
    if (spec === ref.spec) continue;
    const list = edits.get(file) ?? [];
    list.push({ start: ref.start, end: ref.end, text: spec });
    edits.set(file, list);
    rewritten++;
  }
}

console.log(`${moves.size} files to move, ${rewritten} specifiers to rewrite in ${edits.size} files`);
if (dry) process.exit(0);

// 1. rewrite the text in place (old locations), 2. git mv
for (const [file, list] of edits) {
  let text = readFileSync(join(ROOT, file), "utf8");
  for (const e of list.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  writeFileSync(join(ROOT, file), text);
}
for (const [from, { to }] of moves) {
  mkdirSync(dirname(join(ROOT, to)), { recursive: true });
  execFileSync("git", ["mv", from, to], { cwd: ROOT });
}

function addToLock(pkg: string, pj: { name: string; version: string; license?: string }): void {
  const lockPath = join(ROOT, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages: Record<string, unknown> };
  const additions: [string, unknown][] = [
    [`node_modules/@lane-pilot/${pkg}`, { resolved: `packages/${pkg}`, link: true }],
    [`packages/${pkg}`, { name: pj.name, version: pj.version, ...(pj.license ? { license: pj.license } : {}) }],
  ];
  let entries = Object.entries(lock.packages);
  for (const [key, value] of additions) {
    if (key in lock.packages) continue;
    const at = entries.findIndex(([k]) => k !== "" && k > key && (k.startsWith("packages/") === key.startsWith("packages/")));
    const pos = at === -1 ? (key.startsWith("packages/") ? entries.length : entries.findIndex(([k]) => k.startsWith("packages/"))) : at;
    entries = [...entries.slice(0, pos), [key, value], ...entries.slice(pos)];
  }
  lock.packages = Object.fromEntries(entries);
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

// 3. package indexes
const byPkg = new Map<string, { entry: string | null; file: string }[]>();
for (const [, { to, entry }] of moves) {
  const p = pkgOf(to);
  if (!p || !/\.(ts|tsx)$/.test(to)) continue;
  const list = byPkg.get(p) ?? [];
  list.push({ entry: entry ?? null, file: to });
  byPkg.set(p, list);
}
for (const [pkg, list] of byPkg) {
  const dir = join(ROOT, "packages", pkg);
  const pkgJsonPath = join(dir, "package.json");
  const subpaths = new Set<string>();
  for (const item of list) {
    const target = item.entry ?? "index";
    if (item.entry) subpaths.add(item.entry);
    const indexFile = join(dir, "src", `${target}.ts`);
    if (indexFile === join(ROOT, item.file)) continue; // the moved file is the entry itself (subpath export)
    const line = `export * from "./${stripExt(posix.relative(`packages/${pkg}/src`, item.file)).replace(/^(\.\/)?/, "")}";\n`;
    const current = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "";
    if (!current.includes(line.trim())) writeFileSync(indexFile, current + line);
  }
  const pj = existsSync(pkgJsonPath)
    ? JSON.parse(readFileSync(pkgJsonPath, "utf8"))
    : { name: `@lane-pilot/${pkg}`, version: "0.1.0", type: "module", private: true, license: "MIT", sideEffects: false, main: "./src/index.ts", types: "./src/index.ts", exports: { ".": "./src/index.ts" } };
  pj.exports = pj.exports ?? { ".": "./src/index.ts" };
  for (const sub of subpaths) pj.exports[`./${sub}`] = `./src/${sub}.ts`;
  writeFileSync(pkgJsonPath, JSON.stringify(pj, null, 2) + "\n");
  addToLock(pkg, pj);
  const link = join(ROOT, "node_modules/@lane-pilot", pkg);
  if (existsSync(join(ROOT, "node_modules/@lane-pilot")) && !existsSync(link)) execFileSync("ln", ["-s", `../../packages/${pkg}`, link]);
}

// 3b. string literals that spell a moved source path (tests that read a source file, the third-party notice, scripts)
{
  const pairs = (map.moves ?? []).filter((m) => /\.(ts|tsx|json)$/.test(m.from) && m.from !== m.to);
  const targets: string[] = [];
  for (const root of ["tests", "packages"]) if (existsSync(join(ROOT, root))) targets.push(...walkAll(root).filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !f.includes("/src/")));
  for (const f of ["THIRD_PARTY_NOTICES.md", "package.json"]) if (existsSync(join(ROOT, f))) targets.push(f);
  // tests/applicability.test.ts compares the evidence text of the setting catalog, which names source files as history
  const targets2 = targets.filter((f) => f !== "tests/applicability.test.ts");
  targets.length = 0; targets.push(...targets2);
  if (existsSync(join(ROOT, "scripts"))) targets.push(...walkAll("scripts").filter((f) => /\.(ts|mjs|sh)$/.test(f) && !f.startsWith("scripts/refactor/")));
  let changed = 0;
  for (const f of targets) {
    let text = readFileSync(join(ROOT, f), "utf8");
    const before = text;
    for (const { from, to } of pairs) {
      if (!text.includes(from)) continue;
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`(?<![A-Za-z0-9_@-])${escaped}`, "g"), to);
    }
    if (text !== before) { writeFileSync(join(ROOT, f), text); changed++; }
  }
  if (changed) console.log(`path strings rewritten in ${changed} files`);
}

// 4. report non-code references to the old paths
const oldPaths = [...moves.keys()];
// Only places that read paths at run time. docs/, *.md and the setting catalog (ui-catalog-hand.json, ui-catalog.ts) name source files as text and were already stale.
const nonCode = ["scripts", "package.json", "tsconfig.json", "vitest.config.ts", "workflows"];
const hits: string[] = [];
for (const root of nonCode) {
  const abs = join(ROOT, root);
  if (!existsSync(abs)) continue;
  const files = statSync(abs).isDirectory() ? walkAll(root) : [root];
  for (const f of files) {
    if (!/\.(py|sh|mjs|cjs|ts|tsx|yml|yaml)$/.test(f) || f.startsWith("scripts/refactor/")) continue;
    let text: string;
    try { text = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
    for (const old of oldPaths) {
      const needle = old.replace(/\.(ts|tsx)$/, "");
      if (text.includes(needle)) hits.push(`${f}: ${old}`);
    }
  }
}
// string paths in code and tests that name a moved source file
for (const file of graph.files) {
  const text = readFileSync(join(ROOT, moveTo(file)), "utf8");
  for (const old of oldPaths) {
    if (!/\.(ts|tsx)$/.test(old)) continue;
    const needle = old.replace(/\.(ts|tsx)$/, "");
    if (text.includes(`"${needle}`) || text.includes(`'${needle}`) || text.includes(`/${needle}`)) hits.push(`${moveTo(file)}: ${old}`);
  }
}
if (hits.length) console.log("references to old paths outside the import graph:\n" + [...new Set(hits)].join("\n"));

// 5. package files that still reach into the plugin
for (const [pkg] of byPkg) {
  const viol: string[] = [];
  for (const f of walkAll(`packages/${pkg}/src`).filter((x) => /\.tsx?$/.test(x))) {
    for (const r of scanFile(f)) if (r.to && roomOf(r.to) !== `@${pkg}`) viol.push(`${f} -> ${r.to}`);
  }
  if (viol.length) console.log(`packages/${pkg} imports outside itself:\n${viol.join("\n")}`);
}
