// Public APIs of the rooms. For every room face (<room>/index.ts, <room>/server/index.ts, <room>/ui/index.ts) the barrel
// re-exports exactly the names other rooms import, and those importers are rewritten to the barrel - unless that would
// create an import cycle (a barrel depends on every file it re-exports from), then the import stays deep and is counted
// by the ratchet in tests/architecture/deep-imports.json.
//   npx tsx scripts/refactor/barrels.ts [--dry]
import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { builtinModules } from "node:module";
import { ROOT, buildGraph, findCycles, posix as toPosix, resolveSpec, roomOf, runtimeClosure, type Graph } from "./graph";

const dry = process.argv.includes("--dry");
const SIDE_EFFECTS = new Set<string>((JSON.parse(readFileSync(join(ROOT, "src/rooms/package.json"), "utf8")).sideEffects as string[]).map((p) => posix.join("src/rooms", p)));

/** Barrels written by an earlier run are removed first, so the run always starts from the files the rooms really have. */
function removeGenerated(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) removeGenerated(p);
    else if (e.name === "index.ts" && readFileSync(p, "utf8").startsWith("// Public API of")) unlinkSync(p);
  }
}
if (!dry) removeGenerated(join(ROOT, "src/rooms"));

const faceOf = (file: string): string | null => {
  const m = /^(src\/rooms\/[^/]+)\/(server|ui)\//.exec(file);
  if (m) return `${m[1]}/${m[2]}`;
  const r = /^(src\/rooms\/[^/]+)\//.exec(file);
  return r ? r[1]! : null;
};
const barrelOf = (face: string) => `${face}/index.ts`;
const isRoomFile = (f: string) => f.startsWith("src/rooms/");
const isProd = (f: string) => f.startsWith("src/rooms/") || f === "server.ts" || f === "host.ts" || f === "app.tsx";

// ---- type information: which exports of a module are values -------------------------------------------------------
const configPath = join(ROOT, "tsconfig.json");
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();
const valueNames = new Map<string, Map<string, boolean>>(); // file -> name -> isValue
function exportsOf(file: string): Map<string, boolean> {
  let cached = valueNames.get(file);
  if (cached) return cached;
  cached = new Map();
  const sf = program.getSourceFile(join(ROOT, file));
  const sym = sf && checker.getSymbolAtLocation(sf);
  if (sym) {
    for (const e of checker.getExportsOfModule(sym)) {
      const target = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
      cached.set(e.name, (target.flags & ts.SymbolFlags.Value) !== 0);
    }
  }
  valueNames.set(file, cached);
  return cached;
}

// ---- candidate imports ---------------------------------------------------------------------------------------------
interface Candidate {
  file: string; // importer
  target: string; // deep file
  face: string; // face folder of the target room
  start: number; end: number; // specifier text range (without quotes)
  names: { name: string; typeOnly: boolean }[];
  typeOnlyDecl: boolean;
}

const graph: Graph = buildGraph();
const candidates: Candidate[] = [];
let skippedShape = 0;
for (const file of graph.files) {
  if (!isProd(file)) continue;
  const text = readFileSync(join(ROOT, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const fromRoom = roomOf(file);
  for (const st of sf.statements) {
    let spec: ts.StringLiteral | undefined;
    let names: { name: string; typeOnly: boolean }[] | null = null;
    let typeOnlyDecl = false;
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      spec = st.moduleSpecifier;
      const c = st.importClause;
      if (!c) { skippedShape++; continue; } // side-effect import
      typeOnlyDecl = c.isTypeOnly;
      if (c.name || !c.namedBindings || !ts.isNamedImports(c.namedBindings)) { skippedShape++; continue; }
      names = c.namedBindings.elements.map((e) => ({ name: (e.propertyName ?? e.name).text, typeOnly: typeOnlyDecl || e.isTypeOnly }));
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      spec = st.moduleSpecifier;
      typeOnlyDecl = st.isTypeOnly;
      names = st.exportClause.elements.map((e) => ({ name: (e.propertyName ?? e.name).text, typeOnly: typeOnlyDecl || e.isTypeOnly }));
    } else continue;
    if (!spec.text.startsWith(".")) continue;
    const to = resolveSpec(file, spec.text);
    if (!to || !/\.(ts|tsx)$/.test(to) || !isRoomFile(to) || SIDE_EFFECTS.has(to)) continue; // a file with an import-time effect is imported where it is needed, never through a barrel
    const toRoom = roomOf(to);
    if (toRoom === fromRoom) continue;
    if (/\/index\.ts$/.test(to) && barrelOf(faceOf(to)!) === to) continue; // already the public file
    // A UI barrel loads every component it re-exports; a .ts model file (or a test) that wants one constant must not pay for that.
    if (faceOf(to)!.endsWith("/ui") && !file.endsWith(".tsx")) continue;
    candidates.push({ file, target: to, face: faceOf(to)!, start: spec.getStart(sf) + 1, end: spec.getEnd() - 1, names: names!, typeOnlyDecl });
  }
}
console.log(`${candidates.length} deep cross-room imports with named bindings (${skippedShape} default/namespace/side-effect imports stay deep)`);

// ---- barrel content, skipping names two files of one face would both export -----------------------------------------
type Entry = { name: string; from: string; type: boolean };
const barrels = new Map<string, Map<string, Entry>>(); // face -> name -> entry
const rejected = new Set<Candidate>();
function planBarrel(c: Candidate, into: Map<string, Map<string, Entry>>): boolean {
  const map = into.get(c.face) ?? new Map<string, Entry>();
  const exp = exportsOf(c.target);
  const adds: Entry[] = [];
  for (const n of c.names) {
    if (!exp.has(n.name)) return false; // not an export we can see (re-export chain?), stay deep
    const existing = map.get(n.name);
    if (existing && existing.from !== c.target) return false; // clash
    adds.push({ name: n.name, from: c.target, type: !exp.get(n.name) });
  }
  for (const e of adds) map.set(e.name, e);
  into.set(c.face, map);
  return true;
}

// ---- cycle guard: apply group by group, keep a group only when no new cycle appears ---------------------------------
const baseCycles = findCycles(graph, (f) => isProd(f) || f.startsWith("packages/")).length;
const groupKey = (c: Candidate) => `${roomOf(c.file)}>${c.face}`;
const groups = new Map<string, Candidate[]>();
for (const c of candidates) groups.set(groupKey(c), [...(groups.get(groupKey(c)) ?? []), c]);
// leaf-ward first: faces that import few other rooms are the safest to route through
const outDegree = new Map<string, number>();
for (const c of candidates) { const k = roomOf(c.file)!; (outDegree.get(k) ?? outDegree.set(k, 0).get(k)!); }
const outRooms = new Map<string, Set<string>>();
for (const c of candidates) outRooms.set(roomOf(c.file)!, (outRooms.get(roomOf(c.file)!) ?? new Set()).add(roomOf(c.target)!));
const order = [...groups.keys()].sort((a, b) => {
  const fa = a.split(">")[1]!, fb = b.split(">")[1]!;
  const da = outRooms.get(roomOf(fa + "/x")!)?.size ?? 0, db = outRooms.get(roomOf(fb + "/x")!)?.size ?? 0;
  return da - db || fa.localeCompare(fb) || a.localeCompare(b);
});

function virtualGraph(applied: Candidate[], planned: Map<string, Map<string, Entry>>): Graph {
  const refs = new Map(graph.refs);
  const files = [...graph.files];
  const byFile = new Map<string, Candidate[]>();
  for (const c of applied) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  for (const [file, cs] of byFile) {
    const list = (graph.refs.get(file) ?? []).map((r) => {
      const hit = cs.find((c) => c.start === r.start);
      return hit ? { ...r, to: barrelOf(hit.face), typeOnly: r.typeOnly } : r;
    });
    refs.set(file, list);
  }
  for (const [face, entries] of planned) {
    const b = barrelOf(face);
    files.push(b);
    const seen = new Map<string, boolean>();
    for (const e of entries.values()) seen.set(e.from, (seen.get(e.from) ?? true) && e.type);
    refs.set(b, [...seen].map(([to, typeOnly]) => ({ spec: "", start: 0, end: 0, typeOnly, to })));
  }
  return { files, refs };
}

const NODE = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
/** Files of the UI bundle that import a node: module (a barrel must not drag one in). */
function uiLeaks(g: Graph): number {
  let n = 0;
  for (const f of runtimeClosure(g, "app.tsx")) for (const r of g.refs.get(f) ?? []) if (!r.to && !r.typeOnly && (r.spec.startsWith("node:") || NODE.has(r.spec.split("/")[0]!))) n++;
  return n;
}
const baseLeaks = uiLeaks(graph);
const bad = (g: Graph, base: number) => findCycles(g, (f) => isProd(f) || f.startsWith("packages/") || f.endsWith("/index.ts")).length > base || uiLeaks(g) > baseLeaks;

const applied: Candidate[] = [];
let kept = 0;
for (const key of order) {
  const cs = groups.get(key)!;
  const trial = new Map([...barrels].map(([k, v]) => [k, new Map(v)]));
  const ok: Candidate[] = [];
  for (const c of cs) if (planBarrel(c, trial)) ok.push(c);
  if (!ok.length) continue;
  if (bad(virtualGraph([...applied, ...ok], trial), baseCycles)) {
    // try one importer file at a time
    for (const c of ok) {
      const t2 = new Map([...barrels].map(([k, v]) => [k, new Map(v)]));
      if (!planBarrel(c, t2)) continue;
      if (bad(virtualGraph([...applied, c], t2), baseCycles)) { rejected.add(c); continue; }
      applied.push(c);
      for (const [k, v] of t2) barrels.set(k, v);
      kept++;
    }
    continue;
  }
  applied.push(...ok);
  for (const [k, v] of trial) barrels.set(k, v);
  kept += ok.length;
}
console.log(`${applied.length} of ${candidates.length} imports go through a barrel; ${candidates.length - applied.length} stay deep (cycle guard or name clash)`);
if (dry) process.exit(0);

// ---- write barrels ------------------------------------------------------------------------------------------------
for (const [face, entries] of barrels) {
  const file = join(ROOT, barrelOf(face));
  const byFrom = new Map<string, { values: string[]; types: string[] }>();
  for (const e of entries.values()) {
    const g = byFrom.get(e.from) ?? { values: [], types: [] };
    (e.type ? g.types : g.values).push(e.name);
    byFrom.set(e.from, g);
  }
  const lines: string[] = [
    `// Public API of ${face.replace("src/rooms/", "")}: what other rooms import. Everything else in this room is private.`,
    `// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.`,
  ];
  for (const [from, g] of [...byFrom].sort((a, b) => a[0].localeCompare(b[0]))) {
    let rel = toPosix(relative(face, from)).replace(/\.(ts|tsx)$/, "");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    if (g.values.length) lines.push(`export { ${g.values.sort().join(", ")} } from "${rel}";`);
    if (g.types.length) lines.push(`export type { ${g.types.sort().join(", ")} } from "${rel}";`);
  }
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) throw new Error(`${barrelOf(face)} exists`);
  writeFileSync(file, lines.join("\n") + "\n");
}
const edits = new Map<string, { start: number; end: number; text: string }[]>();
for (const c of applied) {
  let rel = toPosix(relative(dirname(c.file), c.face));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  edits.set(c.file, [...(edits.get(c.file) ?? []), { start: c.start, end: c.end, text: rel }]);
}
for (const [file, list] of edits) {
  let text = readFileSync(join(ROOT, file), "utf8");
  for (const e of list.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  writeFileSync(join(ROOT, file), text);
}
console.log(`wrote ${barrels.size} barrels, rewrote ${applied.length} imports in ${edits.size} files`);
