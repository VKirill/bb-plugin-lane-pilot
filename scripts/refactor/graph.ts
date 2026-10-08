// Import graph of the plugin, built with the TypeScript API. Used by the codemod (scripts/refactor/move.ts)
// and by the boundary test (tests/architecture/boundaries.test.ts). No other dependency than typescript.
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface ImportRef {
  /** text of the specifier as written */
  spec: string;
  /** absolute character range of the specifier text without quotes */
  start: number;
  end: number;
  /** true for `import type`, `export type`, and imports whose named bindings are all inline `type` */
  typeOnly: boolean;
  /** resolved file relative to ROOT (posix), or null for third party / unresolved */
  to: string | null;
}

const SKIP_DIRS = new Set(["node_modules", ".claude", "dist", ".git", ".gitnexus", "coverage", ".bb", ".agents"]);
const EXT = [".ts", ".tsx", ".json", ".mjs", ".js", ".d.ts"];

export function posix(p: string): string {
  return p.split(sep).join("/");
}

/** All source files that take part in the graph, relative to ROOT. */
export function listSourceFiles(root = ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(posix(relative(root, join(dir, entry.name))));
      } else if (entry.name.endsWith(".d.ts")) {
        out.push(posix(relative(root, join(dir, entry.name))));
      }
    }
  };
  for (const top of ["src", "packages", "tests", "components", "lib", "scripts"]) {
    if (existsSync(join(root, top))) walk(join(root, top));
  }
  for (const f of ["server.ts", "host.ts", "app.tsx", "i18n.ts"]) if (existsSync(join(root, f))) out.push(f);
  // Files git ignores (local scratch such as scripts/live-*.ts) are not part of the plugin: leave them out of the graph.
  let ignored = new Set<string>();
  try {
    const listed = execFileSync("git", ["-C", root, "check-ignore", "--stdin"], { input: out.join("\n"), stdio: ["pipe", "pipe", "ignore"] }).toString();
    ignored = new Set(listed.split("\n").filter(Boolean));
  } catch { /* exit 1 = nothing ignored, or not a git checkout */ }
  return out.filter((f) => !ignored.has(f)).sort();
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a specifier written in `fromRel` (relative to ROOT) to a file relative to ROOT. */
export function resolveSpec(fromRel: string, spec: string, root = ROOT): string | null {
  let base: string;
  if (spec.startsWith(".")) {
    base = resolve(root, dirname(fromRel), spec);
  } else if (spec.startsWith("@lane-pilot/")) {
    const [, name, ...rest] = spec.split("/");
    const pkgDir = join(root, "packages", name!);
    if (!existsSync(pkgDir)) return null;
    if (rest.length === 0) return resolveWithExt(join(pkgDir, "src/index"), root);
    return resolveWithExt(join(pkgDir, "src", ...rest), root);
  } else if (spec.startsWith("@/")) {
    base = resolve(root, spec.slice(2));
  } else {
    return null;
  }
  return resolveWithExt(base, root);
}

function resolveWithExt(base: string, root: string): string | null {
  if (isFile(base)) return posix(relative(root, base));
  for (const ext of EXT) if (isFile(base + ext)) return posix(relative(root, base + ext));
  const stripped = base.replace(/\.(m?js)$/, "");
  if (stripped !== base) for (const ext of [".ts", ".tsx"]) if (isFile(stripped + ext)) return posix(relative(root, stripped + ext));
  for (const ext of EXT) if (isFile(join(base, "index" + ext))) return posix(relative(root, join(base, "index" + ext)));
  return null;
}

const MOCK_CALLEES = new Set(["vi.mock", "vi.doMock", "vi.unmock", "vi.importActual", "vi.importMock", "vi.hoisted", "require", "jest.mock"]);

function calleeText(node: ts.CallExpression): string {
  return node.expression.getText();
}

/** Every module specifier of a file: import/export-from, dynamic import(), import("x") types, vi.mock, require. */
export function scanFile(rel: string, root = ROOT, text?: string): ImportRef[] {
  const source = text ?? readFileSync(join(root, rel), "utf8");
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.ES2022, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const refs: ImportRef[] = [];
  const add = (lit: ts.StringLiteralLike, typeOnly: boolean) => {
    const spec = lit.text;
    refs.push({ spec, start: lit.getStart(sf) + 1, end: lit.getEnd() - 1, typeOnly, to: resolveSpec(rel, spec, root) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let typeOnly = false;
      if (clause) {
        if (clause.isTypeOnly) typeOnly = true;
        else if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0) {
          typeOnly = clause.namedBindings.elements.every((e) => e.isTypeOnly);
        }
      }
      add(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      add(node.moduleReference.expression, false);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]!)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || MOCK_CALLEES.has(calleeText(node))) add(node.arguments[0] as ts.StringLiteralLike, false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

export interface Graph {
  files: string[];
  refs: Map<string, ImportRef[]>;
}

export function buildGraph(root = ROOT): Graph {
  const files = listSourceFiles(root);
  const refs = new Map<string, ImportRef[]>();
  for (const f of files) refs.set(f, scanFile(f, root));
  return { files, refs };
}

/** Strongly connected components of size > 1 over runtime (not type-only) edges. */
export function findCycles(graph: Graph, include: (file: string) => boolean = () => true): string[][] {
  const adj = new Map<string, string[]>();
  for (const f of graph.files) {
    if (!include(f)) continue;
    const out = new Set<string>();
    for (const r of graph.refs.get(f) ?? []) if (r.to && !r.typeOnly && include(r.to) && r.to !== f && /\.(ts|tsx)$/.test(r.to)) out.add(r.to);
    adj.set(f, [...out]);
  }
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  // iterative Tarjan: the graph is deep enough to overflow the call stack
  for (const start of adj.keys()) {
    if (idx.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const nexts = adj.get(frame.v) ?? [];
      if (frame.i < nexts.length) {
        const w = nexts[frame.i++]!;
        if (!adj.has(w)) continue;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, idx.get(w)!));
        }
      } else {
        if (low.get(frame.v) === idx.get(frame.v)) {
          const comp: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
            if (w === frame.v) break;
          }
          if (comp.length > 1) sccs.push(comp.sort());
        }
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
      }
    }
  }
  return sccs.sort((a, b) => b.length - a.length);
}

/** Files reached at runtime from an entry (type-only edges ignored). */
export function runtimeClosure(graph: Graph, entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    for (const r of graph.refs.get(f) ?? []) {
      if (!r.to || r.typeOnly || seen.has(r.to)) continue;
      seen.add(r.to);
      queue.push(r.to);
    }
  }
  return seen;
}

/** `src/rooms/<room>/...` -> room name, `packages/<pkg>/...` -> "@pkg", otherwise null. */
export function roomOf(file: string): string | null {
  const m = /^src\/rooms\/([^/]+)\//.exec(file);
  if (m) return m[1]!;
  const p = /^packages\/([^/]+)\//.exec(file);
  return p ? `@${p[1]}` : null;
}
