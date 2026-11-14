// Where a declared unit lives in a source file and what its body says — the span a proof anchor names. Regex and a
// light scanner (strings, template literals and comments are skipped while braces are matched), no AST: this ships in
// the plugin, so it stays free of dev dependencies (exports.ts says why). Used by reach.ts (setting reads of a node's
// function), hollow.ts (a function that returns a constant) and scripts/sma-provenance.ts (the lines a node's change
// point is blamed on).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export type SymbolSpan = { name: string; start: number; end: number; body: string; params: string | null; text: string };

const esc = (name: string) => name.replace(/[$]/g, "\\$");

/** The index just past a string, template literal or comment starting at `at`, or `at` when none starts there. */
function skipQuoted(text: string, at: number): number {
  const ch = text[at];
  if (ch === "/" && text[at + 1] === "/") { const nl = text.indexOf("\n", at); return nl < 0 ? text.length : nl; }
  if (ch === "/" && text[at + 1] === "*") { const close = text.indexOf("*/", at + 2); return close < 0 ? text.length : close + 2; }
  if (ch === "\"" || ch === "'") {
    for (let i = at + 1; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === ch || text[i] === "\n") return i + 1;
    }
    return text.length;
  }
  if (ch === "`") {
    for (let i = at + 1; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "`") return i + 1;
      if (text[i] === "$" && text[i + 1] === "{") { i = matchClose(text, i + 1) ; continue; }
    }
    return text.length;
  }
  return at;
}

/** The index of the bracket that closes the one at `open` ({, ( or [), or the end of the text. */
export function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const skipped = skipQuoted(text, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    const ch = text[i]!;
    if (pairs[ch]) stack.push(pairs[ch]!);
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (stack.pop() !== ch) return i;
      if (!stack.length) return i;
    }
  }
  return text.length - 1;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** End of a `const X = …` statement: the first `;` at depth 0, or a newline at depth 0 followed by a new statement. */
function statementEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const skipped = skipQuoted(text, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    const ch = text[i]!;
    if (ch === "{" || ch === "(" || ch === "[") { i = matchClose(text, i); continue; }
    if (ch === ";") return i;
    if (ch === "\n" && /^\n\s*(?:export\b|const\b|let\b|function\b|async\b|class\b|type\b|interface\b|import\b|\/\/|\/\*|$)/.test(text.slice(i, i + 40)) && text.slice(from, i).trim()) {
      const before = text.slice(from, i).trimEnd();
      if (!/[=,(+\-*/?:&|]$/.test(before)) return i;
    }
  }
  return text.length - 1;
}

/** The body brace of a function whose parameter list closes at `paramsClose`: skips a return type annotation that is
 * itself a brace type (`): { ok: boolean } {`). Null for a concise arrow (`=> expr`). */
function bodyBrace(text: string, paramsClose: number): number | null {
  let i = paramsClose + 1;
  for (; i < text.length; i++) {
    const skipped = skipQuoted(text, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    const ch = text[i]!;
    if (ch === "=" && text[i + 1] === ">") {
      const after = text.slice(i + 2).match(/^\s*/)![0].length + i + 2;
      return text[after] === "{" ? after : null;
    }
    if (ch === "{") {
      const close = matchClose(text, i);
      const next = text.slice(close + 1).match(/^\s*(\S{0,2})/)![1]!;
      if (next.startsWith("{") || next === "=>" || next.startsWith("|") || next.startsWith("&")) { i = close; continue; }
      return i;
    }
    if (ch === ";") return null;
    if (ch === "(" || ch === "[" || ch === "<") { if (ch !== "<") i = matchClose(text, i); continue; }
  }
  return null;
}

/** The declared unit `name` in a module: function, const/let/var, class, method or object key, at any depth.
 * Prefers a top-level declaration over a member of the same name. */
export function symbolSpan(text: string, name: string): SymbolSpan | null {
  const n = esc(name);
  const tries: Array<{ re: RegExp; kind: "function" | "const" | "class" | "member" }> = [
    { re: new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\*?\\s+${n}\\s*[<(]`), kind: "function" },
    { re: new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${n}\\b(?:\\s*:[^\\n]*?)?\\s*=(?![=>])`), kind: "const" },
    { re: new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`), kind: "class" },
    { re: new RegExp(`(?:^|\\n)[ \\t]*(?:(?:public|private|protected|static|readonly|async|get|set)\\s+)*["']?${n}["']?\\s*(?:<[^>\\n]*>)?\\s*(?:\\(|:\\s*(?:async\\s*)?(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>))`), kind: "member" },
    { re: new RegExp(`(?:^|\\n)[ \\t]*["']?${n}["']?\\s*:`), kind: "member" },
    { re: new RegExp(`\\b(?:export\\s+)?(?:type|interface|enum)\\s+${n}\\b`), kind: "const" },
  ];
  for (const { re, kind } of tries) {
    const hit = re.exec(text);
    if (!hit) continue;
    const declAt = hit.index + (hit[0].startsWith("\n") ? 1 : 0);
    const startLine = lineOf(text, declAt);
    let endIndex: number;
    let params: string | null = null;
    let body: string;
    if (kind === "class") {
      const brace = text.indexOf("{", hit.index + hit[0].length);
      endIndex = brace < 0 ? hit.index + hit[0].length : matchClose(text, brace);
      body = brace < 0 ? "" : text.slice(brace + 1, endIndex);
    } else if (kind === "function" || (kind === "member" && text[hit.index + hit[0].length - 1] === "(")) {
      const open = text.indexOf("(", hit.index + hit[0].length - 1);
      const close = matchClose(text, open);
      params = text.slice(open + 1, close);
      const brace = bodyBrace(text, close);
      if (brace === null) { endIndex = statementEnd(text, close + 1); body = text.slice(close + 1, endIndex).replace(/^[^=]*=>/, "").trim(); }
      else { endIndex = matchClose(text, brace); body = text.slice(brace + 1, endIndex); }
    } else {
      const eq = hit.index + hit[0].length;
      endIndex = statementEnd(text, eq);
      const init = text.slice(eq, endIndex);
      // An arrow or function initializer: the params and the body of the function itself.
      const arrow = /^\s*(?:async\s*)?(?:function\b[^(]*)?\(/.exec(init);
      if (arrow) {
        const open = eq + arrow[0].length - 1;
        const close = matchClose(text, open);
        const brace = bodyBrace(text, close);
        if (close < endIndex || brace !== null) {
          params = text.slice(open + 1, close);
          if (brace !== null && brace <= endIndex + 1) { endIndex = Math.max(endIndex, matchClose(text, brace)); body = text.slice(brace + 1, matchClose(text, brace)); }
          else body = text.slice(close + 1, endIndex).replace(/^[^=]*=>/, "").trim();
        } else body = init.trim();
      } else body = init.trim();
      if (/^\s*[A-Za-z_$][\w$]*\s*=>/.test(init) && params === null) { params = init.match(/^\s*([A-Za-z_$][\w$]*)/)![1]!; body = init.replace(/^\s*[A-Za-z_$][\w$]*\s*=>/, "").trim(); }
    }
    return { name, start: startLine, end: lineOf(text, endIndex), body, params, text: text.slice(declAt, endIndex + 1) };
  }
  return null;
}

/** A module path an import names, as a file under `root`: relative paths (with .ts/.tsx/index.ts) and @lane-pilot packages. */
function resolveModule(root: string, fromFile: string, spec: string): string | null {
  const base = spec.startsWith(".") ? join(dirname(join(root, fromFile)), spec)
    : spec.startsWith("@lane-pilot/") ? join(root, "packages", spec.slice("@lane-pilot/".length), "src", "index") : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base.replace(/\.js$/, ".ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(root, candidate);
  }
  return null;
}

/** The span of `name` as `file` (relative to `root`) declares it, following `export { name } from` and
 * `import { name } from` up to four hops — a proof anchored in a room's index names the unit behind the re-export. */
export function resolveSpan(root: string, file: string, name: string, hops = 4): (SymbolSpan & { file: string }) | null {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const own = symbolSpan(text, name);
  if (own) return { ...own, file };
  if (hops <= 0) return null;
  for (const hit of text.matchAll(/(?:export|import)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = hit[1]!.split(",").map((item) => item.trim().replace(/^type\s+/, ""));
    const match = names.find((item) => item.split(/\s+as\s+/).pop()!.trim() === name);
    if (!match) continue;
    const target = resolveModule(root, file, hit[2]!);
    if (!target) continue;
    const found = resolveSpan(root, target, match.split(/\s+as\s+/)[0]!.trim(), hops - 1);
    if (found) return found;
  }
  for (const hit of text.matchAll(/export\s+\*\s+from\s*["']([^"']+)["']/g)) {
    const target = resolveModule(root, file, hit[1]!);
    const found = target ? resolveSpan(root, target, name, hops - 1) : null;
    if (found) return found;
  }
  return null;
}

/** The anchor name a proof's `#symbol` part names (`export function foo(` → foo), or null for a text anchor. */
export function anchorName(symbol: string): string | null {
  const declared = /(?:function\*?\s+|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/.exec(symbol)?.[1];
  return declared ?? (/^[A-Za-z_$][\w$]*$/.test(symbol) ? symbol : null);
}

/** The workflow node object (`"id": "<node>"`) in a pretty-printed workflow JSON, as a line span. */
export function workflowNodeSpan(text: string, nodeId: string): SymbolSpan | null {
  const at = text.search(new RegExp(`"id"\\s*:\\s*"${nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  if (at < 0) return null;
  const open = text.lastIndexOf("{", at);
  const close = matchClose(text, open);
  return { name: nodeId, start: lineOf(text, open), end: lineOf(text, close), body: text.slice(open, close + 1), params: null, text: text.slice(open, close + 1) };
}

/** Strings a body names as literals ("phase.rails", 'writer.max_turns'): candidates for setting reads. */
export function stringLiterals(body: string): string[] {
  return [...body.matchAll(/["'`]([A-Za-z_][\w-]*(?:\.[\w-]+)+)["'`]/g)].map((hit) => hit[1]!);
}

/** A constant answer with no work: the whole body returns a literal (null, undefined, [], {}, true, false, a number, a
 * string, or an object/array of literals only). Null when the body does some work. */
export function constantReturn(body: string): string | null {
  const cleaned = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim();
  // A block body is statements («return x;»); a concise arrow body is the expression itself, an object one in parens.
  const expr = /^return\s+([^;]*?);?\s*$/.exec(cleaned)?.[1] ?? ((cleaned.startsWith("(") || /^[^;{}]*$/.test(cleaned)) && !/^return\b/.test(cleaned) ? cleaned.replace(/;$/, "") : null);
  if (expr === null) return cleaned === "" ? "(empty body)" : null;
  const e = expr.trim().replace(/\s+as\s+const$/, "").replace(/^\((.*)\)$/s, "$1").trim();
  const literal = /^(?:null|undefined|true|false|-?\d+(?:\.\d+)?|"[^"\n]*"|'[^'\n]*'|`[^`$\n]*`|\[\s*\]|\{\s*\})$/;
  if (literal.test(e)) return e;
  // An object or array whose values are all literals ({ ok: true }, ["a"]).
  if (/^\{[\s\S]*\}$|^\[[\s\S]*\]$/.test(e)) {
    const inner = e.slice(1, -1).trim();
    const parts = inner.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length && parts.every((part) => literal.test(part.replace(/^["']?[A-Za-z_$][\w$-]*["']?\s*:\s*/, "")))) return e;
  }
  return null;
}
