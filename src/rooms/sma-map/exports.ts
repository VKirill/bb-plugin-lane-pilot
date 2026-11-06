// The repository's export surface and source text as indexes, built once and only when a proof's own `path#anchor`
// does not hold (the file moved or the anchor was renamed). This is what lets a proof survive a move: `x.ts#open`
// still resolves while `open` is exported anywhere in the repository, and a text anchor resolves while some source
// file still carries it. tests/ are left out — a proof counts production code only.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listSourceFiles } from "../../../scripts/refactor/graph";

const sources = (root: string) => listSourceFiles(root).filter((f) => !f.startsWith("tests/") && /\.tsx?$/.test(f));

function* boundNames(name: ts.BindingName | undefined): Generator<string> {
  if (!name) return;
  if (ts.isIdentifier(name)) yield name.text;
  else for (const el of name.elements) if (ts.isBindingElement(el)) yield* boundNames(el.name);
}

/** Names a module exports: declared exports, `export { a as b }` lists (the exported alias), `default`. */
function exportedOf(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names: string[] = [];
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) names.push(e.name.text);
      continue;
    }
    const mods = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
    if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) names.push(...boundNames(d.name));
    else {
      const name = (st as unknown as ts.NamedDeclaration).name;
      if (name && ts.isIdentifier(name)) names.push(name.text);
    }
    if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) names.push("default");
  }
  return names;
}

type Index = { exported: Map<string, Set<string>>; corpus: Map<string, string> };
const caches = new Map<string, Index>();

function repoIndex(root: string): Index {
  let cached = caches.get(root);
  if (cached) return cached;
  cached = { exported: new Map(), corpus: new Map() };
  for (const rel of sources(root)) {
    const text = readFileSync(join(root, rel), "utf8");
    cached.corpus.set(rel, text);
    for (const name of exportedOf(rel, text)) {
      const set = cached.exported.get(name) ?? new Set<string>();
      set.add(rel);
      cached.exported.set(name, set);
    }
  }
  caches.set(root, cached);
  return cached;
}

/** Files exporting `symbol`, resolved through the module surface (not text). */
export function symbolLocations(root: string, symbol: string): string[] {
  return [...(repoIndex(root).exported.get(symbol) ?? [])];
}

/** The first source file still carrying `anchor` as text, or null. */
export function textLocation(root: string, anchor: string): string | null {
  for (const [file, text] of repoIndex(root).corpus) if (text.includes(anchor)) return file;
  return null;
}

export const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
