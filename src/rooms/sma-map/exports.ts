// The repository's export surface and source text as indexes, built once and only when a proof's own `path#anchor`
// does not hold — i.e. only inside `bb lane-pilot sma-map --check-proofs/--fix-proofs` and tests. Production code
// imports sma-map for the map and the live queries; this file must stay free of dev dependencies (typescript,
// scripts/*) so the shipped plugin can load it — the scan is regex + fs, no AST.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "tests", "test"]);
const TOP = ["src", "packages", "scripts"];
const ENTRY = ["server.ts", "host.ts", "app.tsx", "i18n.ts"];

function* sources(root: string): Generator<string> {
  const walk = function* (dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) yield* walk(path);
      else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) yield path;
    }
  };
  for (const top of TOP) if (existsSync(join(root, top))) yield* walk(join(root, top));
  for (const file of ENTRY) if (existsSync(join(root, file))) yield join(root, file);
}

const DECL = /export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const LIST = /export\s*(?:type\s*)?\{([^}]*)\}/g;
const BINDING = /export\s+(?:declare\s+)?(?:const|let|var)\s*\{([^}]*)\}/g;
const lastName = (part: string) => /([A-Za-z_$][\w$]*)\s*$/.exec(part.replace(/=[^=]*$/, "").trim())?.[1];

/** Names a module exports: declared exports, `export { a as b }` lists (the exported alias), `default`. */
function exportedOf(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(DECL)) names.push(m[1]!);
  for (const m of text.matchAll(LIST)) for (const part of m[1]!.split(",")) { const name = lastName(part); if (name) names.push(name); }
  for (const m of text.matchAll(BINDING)) for (const part of m[1]!.split(",")) { const name = lastName(part.replace(/:\s*[^,]+/, ": ")); if (name) names.push(name); }
  if (/export\s+default\b/.test(text)) names.push("default");
  return names;
}

type Index = { exported: Map<string, Set<string>>; corpus: Map<string, string> };
const caches = new Map<string, Index>();

function repoIndex(root: string): Index {
  let cached = caches.get(root);
  if (cached) return cached;
  cached = { exported: new Map(), corpus: new Map() };
  for (const abs of sources(root)) {
    const rel = abs.slice(root.length + 1).split("\\").join("/");
    const text = readFileSync(abs, "utf8");
    cached.corpus.set(rel, text);
    for (const name of exportedOf(text)) {
      const set = cached.exported.get(name) ?? new Set<string>();
      set.add(rel);
      cached.exported.set(name, set);
    }
  }
  caches.set(root, cached);
  return cached;
}

export const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The file an anchor moved to: exactly one candidate (an exporting module for identifier anchors, else a text carrier) or null. */
export function relocateAnchor(root: string, anchor: string): string | null {
  const { exported, corpus } = repoIndex(root);
  let at = IDENTIFIER.test(anchor) ? [...(exported.get(anchor) ?? [])] : [];
  if (!at.length) at = [...corpus].filter(([, text]) => text.includes(anchor)).map(([file]) => file);
  return at.length === 1 ? at[0]! : null;
}

/** Files exporting `symbol` (diagnostics). */
export function symbolLocations(root: string, symbol: string): string[] {
  return [...(repoIndex(root).exported.get(symbol) ?? [])];
}
