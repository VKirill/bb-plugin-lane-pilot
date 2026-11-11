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
export function exportedOf(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(DECL)) names.push(m[1]!);
  for (const m of text.matchAll(LIST)) for (const part of m[1]!.split(",")) { const name = lastName(part); if (name) names.push(name); }
  for (const m of text.matchAll(BINDING)) for (const part of m[1]!.split(",")) { const name = lastName(part.replace(/:\s*[^,]+/, ": ")); if (name) names.push(name); }
  if (/export\s+default\b/.test(text)) names.push("default");
  return names;
}

type Index = { exported: Map<string, Set<string>>; declared: Map<string, Set<string>>; corpus: Map<string, string> };
const caches = new Map<string, Index>();

function repoIndex(root: string): Index {
  let cached = caches.get(root);
  if (cached) return cached;
  cached = { exported: new Map(), declared: new Map(), corpus: new Map() };
  const add = (map: Map<string, Set<string>>, name: string, file: string) => {
    const set = map.get(name) ?? new Set<string>();
    set.add(file);
    map.set(name, set);
  };
  for (const abs of sources(root)) {
    const rel = abs.slice(root.length + 1).split("\\").join("/");
    const text = readFileSync(abs, "utf8");
    cached.corpus.set(rel, text);
    for (const name of exportedOf(text)) add(cached.exported, name, rel);
    for (const name of declaredNames(text, rel.endsWith("x"))) add(cached.declared, name, rel);
  }
  caches.set(root, cached);
  return cached;
}

export const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const DECL_ANCHOR = /^export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/**
 * Blank out comments, string/template/regex literals (length and newlines preserved) so declaration patterns can run
 * on code only. A `/` opens a regex when the previous significant character cannot end an expression — the classic
 * ambiguity resolved the usual way; misjudged divisions only leave a `/` in code, which no declaration pattern reads.
 */
export function maskLiterals(text: string, jsx: boolean): string {
  const out = text.split("");
  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl" | "regex";
  // `expr` frames are `${…}` substitutions inside a template: they behave as code but pop back to `tpl` on the `}`
  // that closes them (depth counts braces opened inside the substitution).
  const stack: { mode: Mode; expr: boolean; depth: number }[] = [{ mode: "code", expr: false, depth: 0 }];
  const top = () => stack[stack.length - 1]!;
  const blank = (i: number) => { if (out[i] !== "\n") out[i] = " "; };
  let prev = ""; // previous significant char in code mode
  let word = "", prevWord = ""; // identifier run and the one before it — `return 'x'` opens a string, JSX text `don't` does not
  // In JSX `</` opens a closing tag and `{expr}/text/` puts `/` after `}` — neither is a regex there.
  // `return /re/.test(x)`: after a keyword the last significant char is a letter, and a `/` still opens a regex.
  const regexAllowed = () => prev === "" || (/[\w$]/.test(prev) && WORDS.has(prevWord)) || (jsx ? "(,=:[!&|?;+-*%^~>".includes(prev) : "(,=:[!&|?{};+-*%^~<>".includes(prev));
  const WORDS = new Set(["return", "typeof", "case", "throw", "delete", "void", "in", "of", "new", "yield", "await", "do", "else"]);
  const stringAllowed = () => prev === "" || "(,=:[{!&|?;+-*%^~".includes(prev) || WORDS.has(prevWord);
  for (let i = 0; i < text.length; i++) {
    const { mode } = top();
    const c = text[i]!;
    const n = text[i + 1] ?? "";
    if (mode === "line") { if (c === "\n") stack.pop(); else blank(i); continue; }
    if (mode === "block") { if (c === "*" && n === "/") { blank(i); blank(i + 1); i++; stack.pop(); } else blank(i); continue; }
    if (mode === "sq" || mode === "dq") {
      const quote = mode === "sq" ? "'" : '"';
      if (c === "\\") { blank(i); if (i + 1 < text.length) blank(i + 1); i++; continue; }
      blank(i);
      if (c === quote) stack.pop();
      continue;
    }
    if (mode === "tpl") {
      if (c === "\\") { blank(i); if (i + 1 < text.length) blank(i + 1); i++; continue; }
      if (c === "`") { blank(i); stack.pop(); continue; }
      if (c === "$" && n === "{") { blank(i); blank(i + 1); i++; stack.push({ mode: "code", expr: true, depth: 0 }); prev = "{"; continue; }
      blank(i); continue;
    }
    if (mode === "regex") {
      if (c === "\\") { blank(i); if (i + 1 < text.length) blank(i + 1); i++; continue; }
      blank(i);
      if (c === "/") { stack.pop(); prev = "/"; }
      else if (c === "[") { // character class: a `/` inside does not end the regex
        let j = i + 1;
        while (j < text.length && text[j] !== "]") { if (text[j] === "\\") j++; j++; }
        for (let k = i; k <= Math.min(j, text.length - 1); k++) blank(k);
        i = j;
      }
      continue;
    }
    // code mode (base frame or a `${}` substitution)
    if (!/[\w$]/.test(c) && word) { prevWord = word; prev = word[word.length - 1]!; word = ""; }
    if (c === "/" && n === "/") { blank(i); blank(i + 1); i++; stack.push({ mode: "line", expr: false, depth: 0 }); continue; }
    if (c === "/" && n === "*") { blank(i); blank(i + 1); i++; stack.push({ mode: "block", expr: false, depth: 0 }); continue; }
    if (c === "'" && (!jsx || stringAllowed())) { blank(i); stack.push({ mode: "sq", expr: false, depth: 0 }); continue; }
    if (c === '"' && (!jsx || stringAllowed())) { blank(i); stack.push({ mode: "dq", expr: false, depth: 0 }); continue; }
    if (c === "`") { blank(i); stack.push({ mode: "tpl", expr: false, depth: 0 }); continue; }
    if (c === "/" && regexAllowed()) { blank(i); stack.push({ mode: "regex", expr: false, depth: 0 }); continue; }
    const frame = top();
    if (frame.expr) {
      if (c === "{") frame.depth++;
      else if (c === "}") { if (frame.depth > 0) frame.depth--; else stack.pop(); }
    }
    if (/[\w$]/.test(c)) word += c;
    else if (!/\s/.test(c)) prev = c;
  }
  return out.join("");
}

const QUOTED_KEY = /(["'])([A-Za-z_$][\w$]*)\1\s*[(:]/g;
const HEAD_DECL = /(?:^|[^\w$])(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)|(?:^|[^\w$])(?:export\s+)?(?:declare\s+)?class\s+([A-Za-z_$][\w$]*)|(?:^|[^\w$])(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)|(?:^|[^\w$])(?:export\s+)?type\s+([A-Za-z_$][\w$]*)|(?:^|[^\w$])(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)|(?:^|[^\w$])(?:export\s+)?(?:declare\s+)?namespace\s+([A-Za-z_$][\w$]*)/g;
const VAR_DECL = /(?:^|[^\w$])(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([^;]+)/g;
const MEMBER = /(?:^|[{},;]|\n)\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|abstract\s+|override\s+|declare\s+|accessor\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*[(:]/gm;
const CASE_DECL = /\bcase\s+([A-Za-z_$][\w$]*)\s*:/g;
const EXPORT_LIST = /\bexport\s*(?:type\s*)?\{([^}]*)\}/g;

/** Words that can precede `(`/`:`/`=` in code without declaring anything — never collected as names. */
const RESERVED = new Set(("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static of as from is asserts keyof typeof infer namespace declare abstract override accessor async await get set public private protected readonly implements interface package require").split(" "));

/** Binding identifiers in a `const|let|var` declarator list: `{a, b: c}` → a,c; `[x,,y]` → x,y; skips initializers after top-level `=`. */
function bindingNames(text: string, out: Set<string>) {
  let depth = 0, skip = false;
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*|[^\w\s]/g)) {
    const t = m[0];
    if (/^[A-Za-z_$]/.test(t)) {
      if (!skip && depth === 0 && (t === "of" || t === "in")) break; // `for (const x of/in y)` — the iterated expression binds nothing
      if (!skip && !RESERVED.has(t)) out.add(t);
      continue;
    }
    if ("([{".includes(t)) depth++;
    else if (")]}".includes(t)) depth = Math.max(0, depth - 1);
    else if (t === "=" && depth === 0) skip = true;
    else if (t === "," && depth === 0) skip = false;
  }
}

/**
 * Every name the file declares, at any depth: functions, classes, interfaces, types, enums, namespaces, const/let/var
 * bindings (including destructured ones), methods, object-literal and quoted property keys, `case` labels and
 * `export {}` aliases. Local-ness is irrelevant — a proof names the unit that implements the claim, exported or not;
 * renaming the unit breaks the proof, renaming an unrelated local does not.
 */
export function declaredNames(text: string, jsx = false): Set<string> {
  const names = new Set<string>();
  const code = maskLiterals(text, jsx);
  for (const m of code.matchAll(HEAD_DECL)) names.add(m.slice(1).find(Boolean)!);
  for (const m of code.matchAll(VAR_DECL)) bindingNames(m[1]!, names);
  for (const m of code.matchAll(MEMBER)) if (!RESERVED.has(m[1]!)) names.add(m[1]!);
  for (const m of code.matchAll(CASE_DECL)) if (!RESERVED.has(m[1]!)) names.add(m[1]!);
  for (const m of text.matchAll(QUOTED_KEY)) names.add(m[2]!);
  for (const m of code.matchAll(EXPORT_LIST)) for (const part of m[1]!.split(",")) { const name = lastName(part); if (name) names.add(name); }
  if (/\bexport\s+default\b/.test(code)) names.add("default");
  return names;
}

/** The proof an anchor moved to: `path#name` where exactly one module declares the name (any depth — the anchor
 * names the unit, exported or not), a bare `path` when the file exists but no declaration can be named for the
 * anchor, or null (deleted, or ambiguous). `--fix-proofs` rewrites the entry then. */
export function relocateAnchor(root: string, anchor: string): string | null {
  const { declared, corpus } = repoIndex(root);
  const name = IDENTIFIER.test(anchor) ? anchor : DECL_ANCHOR.exec(anchor)?.[1] ?? null;
  if (name) {
    const at = [...(declared.get(name) ?? [])];
    if (at.length === 1) return `${at[0]}#${name}`;
    if (at.length > 1) return null;
  }
  const carriers = [...corpus].filter(([, text]) => text.includes(anchor)).map(([file]) => file);
  if (carriers.length !== 1) return null;
  const file = carriers[0]!;
  const head = /[A-Za-z_$][\w$]*/.exec(anchor)?.[0];
  if (head && declaredNames(corpus.get(file)!, file.endsWith("x")).has(head)) return `${file}#${head}`;
  return file;
}

/** Files declaring `symbol` (diagnostics). */
export function symbolLocations(root: string, symbol: string): string[] {
  return [...(repoIndex(root).declared.get(symbol) ?? [])];
}
