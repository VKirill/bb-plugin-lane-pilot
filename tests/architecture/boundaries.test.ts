import { builtinModules } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ROOT, buildGraph, findCycles, resolveSpec, roomOf, runtimeClosure, type Graph } from "../../scripts/refactor/graph";

/**
 * Import boundaries of the plugin, checked on every `npx vitest run` (the deploy gate runs it too).
 * The graph is built with the TypeScript API from scripts/refactor/graph.ts; no new dependency.
 *
 * Layout: packages/<name> (shared, imported as @lane-pilot/<name>) and src/rooms/<room> (one domain each).
 * A room has up to three public files: index.ts (domain), server/index.ts, ui/index.ts. Another room imports only
 * those. The imports that still reach into a room's private files are counted in deep-imports.json: the count
 * of a room pair may only go down (UPDATE_ARCH_BASELINE=1 rewrites the file after you removed some).
 */

const graph: Graph = buildGraph();
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const isNode = (spec: string) => spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0]!);

/** Value-level import cycles that still exist. Empty since the two known ones were cut. */
const ALLOW_CYCLES = new Set<string>([]);

/** Which package may import which (everything else is a violation). A package never imports src/. */
const PACKAGE_DEPENDENCIES: Record<string, string[]> = {
  "@contracts": ["@kit"],
  "@host-calls": ["@contracts", "@kit"],
  "@workflow-engine": ["@contracts", "@kit", "@models"],
  "@i18n": ["@settings-catalog"],
  "@jev": ["@kit"],
  "@run-insights": ["@memory-core"],
  "@settings-catalog": ["@kit"],
};

const production = (file: string) => !file.startsWith("tests/") && !file.startsWith("scripts/");
const isEntry = (file: string) => file === "server.ts" || file === "host.ts" || file === "app.tsx";
const roomName = (file: string) => /^src\/rooms\/([^/]+)\//.exec(file)?.[1] ?? null;
/** The public files of a room: its three index files. */
const isPublic = (file: string) => /^src\/rooms\/[^/]+\/(?:(?:server|ui)\/)?index\.tsx?$/.test(file);

function deepImports(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of graph.files) {
    if (!production(file) || !(roomName(file) || isEntry(file))) continue;
    const from = roomName(file) ?? "entry";
    for (const ref of graph.refs.get(file) ?? []) {
      if (!ref.to) continue;
      const to = roomName(ref.to);
      if (!to || to === roomName(file) || isPublic(ref.to)) continue;
      const key = `${from} > ${to}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

describe("import boundaries", () => {
  it("has no value-level import cycles beyond the allowlist", () => {
    const cycles = findCycles(graph, production).filter((c) => !ALLOW_CYCLES.has(c.join(">")));
    expect(cycles.map((c) => c.join(" > "))).toEqual([]);
  });

  it("keeps packages free of the plugin sources and layered", () => {
    const bad: string[] = [];
    for (const file of graph.files) {
      if (!file.startsWith("packages/") || file.includes("/tests/")) continue;
      const self = roomOf(file)!;
      for (const ref of graph.refs.get(file) ?? []) {
        if (!ref.to) continue;
        const target = roomOf(ref.to);
        if (!target || !target.startsWith("@")) bad.push(`${file} -> ${ref.to}`);
        else if (target !== self) {
          if (ref.spec.startsWith(".")) bad.push(`${file} -> ${ref.to} (reach into another package by path, use @lane-pilot/${target.slice(1)})`);
          else if (!(PACKAGE_DEPENDENCIES[self] ?? []).includes(target)) bad.push(`${file}: ${self} may not depend on ${target}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps node: builtins out of the UI bundle", () => {
    const closure = runtimeClosure(graph, "app.tsx");
    const bad: string[] = [];
    for (const file of closure) {
      for (const ref of graph.refs.get(file) ?? []) if (!ref.typeOnly && !ref.to && isNode(ref.spec)) bad.push(`${file} imports ${ref.spec}`);
    }
    expect(bad).toEqual([]);
    expect(closure.size).toBeGreaterThan(50);
  });

  it("keeps the UI and the server from importing each other", () => {
    const bad: string[] = [];
    for (const file of graph.files) {
      if (!production(file)) continue;
      const ui = /(^|\/)ui\//.test(file) && !file.startsWith("packages/");
      const server = /(^|\/)server\//.test(file);
      for (const ref of graph.refs.get(file) ?? []) {
        if (!ref.to || ref.typeOnly) continue;
        if (ui && /^src\/rooms\/[^/]+\/server\//.test(ref.to)) bad.push(`${file} -> ${ref.to}`);
        if (server && /^src\/rooms\/[^/]+\/ui\//.test(ref.to)) bad.push(`${file} -> ${ref.to}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("builds the three entries from files that exist and import something", () => {
    for (const entry of ["server.ts", "host.ts", "app.tsx"]) {
      expect(graph.files, entry).toContain(entry);
      expect(runtimeClosure(graph, entry).size, entry).toBeGreaterThan(20);
    }
  });

  it("has src/ only as src/rooms/<room>/, every room with files, and no import into a missing file", () => {
    const stray = graph.files.filter((f) => f.startsWith("src/") && !f.startsWith("src/rooms/"));
    expect(stray).toEqual([]);
    const unresolved: string[] = [];
    for (const file of graph.files) for (const ref of graph.refs.get(file) ?? []) if (ref.spec.startsWith(".") && !ref.to) unresolved.push(`${file}: ${ref.spec}`);
    expect(unresolved).toEqual([]);
  });

  it("enters another room only through its index files (deep imports are counted and may only go down)", () => {
    const path = join(ROOT, "tests/architecture/deep-imports.json");
    const actual = deepImports();
    const asObject = Object.fromEntries([...actual].sort((a, b) => a[0].localeCompare(b[0])));
    if (process.env.UPDATE_ARCH_BASELINE === "1") writeFileSync(path, JSON.stringify(asObject, null, 1) + "\n");
    const baseline = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
    const grown = Object.entries(asObject).filter(([pair, n]) => n > (baseline[pair] ?? 0)).map(([pair, n]) => `${pair}: ${baseline[pair] ?? 0} -> ${n}`);
    expect(grown, "a new import into the private files of another room: import its index instead (src/rooms/<room>[/server|/ui]/index.ts, add the name there)").toEqual([]);
    const shrunk = Object.entries(baseline).filter(([pair, n]) => (asObject[pair] ?? 0) < n).map(([pair, n]) => `${pair}: ${n} -> ${asObject[pair] ?? 0}`);
    expect(shrunk, "fewer deep imports than the baseline: run UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture").toEqual([]);
  });

  it("lists every room file that does something when it is imported in src/rooms/package.json (sideEffects)", () => {
    const listed = new Set<string>((JSON.parse(readFileSync(join(ROOT, "src/rooms/package.json"), "utf8")).sideEffects as string[]).map((p) => `src/rooms/${p.replace(/^\.\//, "")}`));
    // Built from a loop over constants, no effect outside the module: dropping it when unused is right.
    const PURE_DESPITE_LOOP = new Set(["src/rooms/workflow/builtin.ts"]);
    const found = new Set<string>();
    for (const file of graph.files) {
      if (!file.startsWith("src/rooms/") || !/\.tsx?$/.test(file)) continue;
      const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.ES2022, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && !st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
          const to = resolveSpec(file, st.moduleSpecifier.text);
          if (to?.startsWith("src/rooms/")) found.add(to);
        }
        if (ts.isExpressionStatement(st) || ts.isIfStatement(st) || ts.isForStatement(st) || ts.isTryStatement(st) || ts.isWhileStatement(st)) found.add(file);
        if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => /\bdefineJudgment\b/.test(d.initializer?.getText() ?? ""))) found.add(file);
      }
    }
    const missing = [...found].filter((f) => !listed.has(f) && !PURE_DESPITE_LOOP.has(f));
    expect(missing, "add it to sideEffects in src/rooms/package.json, or keep top-level effects out of the room").toEqual([]);
    expect([...listed].filter((f) => !existsSync(join(ROOT, f)))).toEqual([]);
  });
});
