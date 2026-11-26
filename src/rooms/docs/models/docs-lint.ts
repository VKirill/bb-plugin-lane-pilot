/**
 * Deterministic checks for docs written by the nightly docs agent, after the docs-methodology
 * skill (claude-lane): frontmatter contract, file:line evidence that points at real lines,
 * no marketing words, links that resolve, and the pages only builders may write.
 */

export const DOC_PAGE_TYPES = ["overview", "architecture", "data-model", "decisions", "deployment", "gotchas", "gaps",
  "active-areas", "active-tasks", "component", "flow", "capabilities", "audience", "index", "conventions", "testing"] as const;
/**
 * A cited path: letters, digits and `_@.[]+-` in a name (Nuxt's `[slug].get.ts`, Expo's `ask+api.ts`), and a route group
 * `(tabs)` only as a whole folder followed by `/`, so a citation in parentheses keeps its own `(`.
 */
const CITATION_PATH = String.raw`(?:[A-Za-z0-9_@.\/\[\]+-]|\([A-Za-z0-9_@.\[\]+-]+\)(?=\/))+\.[A-Za-z][A-Za-z0-9]*`;
/** `path:line` or `path:start-end`; groups: the path, the first line, the last line. */
export const CITATION_SOURCE = String.raw`(${CITATION_PATH}):(\d+)(?:-(\d+))?`;
const CITATION = new RegExp(CITATION_SOURCE, "g");

export type DocPage = { path:string; content:string };

/** A page in a docs folder: the project's docs/ or a monorepo workspace's own <workspace>/docs/. */
export const isDocsPage = (path:string):boolean => /(^|\/)docs\/.+\.md$/.test(path);
/** The builder-owned index of a docs folder. */
export const isDocsIndex = (path:string):boolean => /(^|\/)docs\/index\.md$/.test(path);
/** DESIGN.md is the design canon the design lead keeps; it lives among the docs but Lane Pilot neither checks nor rewrites it. */
export const isDesignCanon = (path:string):boolean => /(^|\/)DESIGN\.md$/.test(path);
/** `target` names the page a finding is about when that is another page: a link's target. */
export type DocsFinding = { path:string; rule:string; detail:string; target?:string };

/**
 * The body with the lines of fenced code blocks emptied: a `# HELP` line of a Prometheus sample or a shell comment
 * inside ``` is code, not a heading (treba, 2026-10-20: «exactly one H1, found 2» on a page whose second H1 was a sample).
 */
export function withoutCodeBlocks(body:string):string {
  let fence:string | null = null;
  return body.split("\n").map((line) => {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null) { if (mark) fence = mark; return line; }
    if (mark && mark[0] === fence[0] && mark.length >= fence.length && !line.trim().slice(mark.length).trim()) fence = null;
    return "";
  }).join("\n");
}

/** `file.ts:10-12,40-44` names two ranges of one file; written out, each is its own citation. */
export function expandCitationLists(text:string):string {
  return text.replace(new RegExp(String.raw`(${CITATION_PATH}):(\d+(?:-\d+)?)((?:,\s*\d+(?:-\d+)?(?![\w.:\/-]))+)`, "g"),
    (_, file:string, first:string, rest:string) => [`${file}:${first}`, ...rest.split(",").map((part) => part.trim()).filter(Boolean).map((range) => `${file}:${range}`)].join(", "));
}

/** Citations in a page body that name a file and a line, with the file relative to the project root. */
export function pageCitations(body:string): Array<{ file:string; start:number; end:number }> {
  const found:Array<{ file:string; start:number; end:number }> = [];
  for (const match of expandCitationLists(body).matchAll(CITATION)) {
    const start = Number(match[2]), end = match[3] ? Number(match[3]) : start;
    found.push({ file:match[1]!.replace(/^\.\//, ""), start, end });
  }
  return found;
}

/** A token a doc claim names that can be found in code: `backticked`, camelCase, snake_case, `call()` or CONSTANT-shaped. */
export function claimIdentifiers(text:string):string[] {
  const ids = new Set<string>();
  const keep = (raw:string) => {
    const token = raw.replace(/\(\)$/, "");
    if (token.length < 3 || /\//.test(token) || /\.(md|[cm]?[jt]sx?|vue|svelte|prisma|json|sql|py|sh|css|html)$/i.test(token)) return;
    ids.add(token);
  };
  for (const match of text.matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?)`/g)) keep(match[1]!);
  // Bare PascalCase and all-caps words can be product names or protocols (OpenCode, POST, HTTPS).
  // Explicit backticks still name types and single-word constants.
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?)\b/g)) {
    const token = match[1]!;
    if (/\(\)$|_|\./.test(token) || (/^[a-z_$]/.test(token) && /[a-z][A-Z]/.test(token))) keep(token);
  }
  return [...ids];
}

/** A citation and the identifiers the sentence that carries it names. */
export function citationClaims(body:string): Array<{ file:string; start:number; end:number; identifiers:string[]; claimIndex:number }> {
  const expanded = expandCitationLists(body);
  const claims:Array<{ file:string; start:number; end:number; identifiers:string[]; claimIndex:number }> = [];
  // Like pageClaims in docs-anchors: independent sentences on one physical line must not borrow
  // each other's evidence. Examples introduced by e.g./i.e. stay part of their sentence.
  // Inline code can contain sentence punctuation (SQL `SELECT ... FOR UPDATE`).
  // Consume code spans first so a separator inside one cannot detach its citation.
  const blocks:string[] = [];
  let from = 0;
  for (const match of expanded.matchAll(/(`+)[\s\S]*?\1(?!`)|\n(?=\s*[-*|]|\s*\n)|(?<=[.!?])(?<!\be\.g\.)(?<!\bi\.e\.)\s+/g)) {
    if (match[1]) continue;
    blocks.push(expanded.slice(from, match.index));
    from = match.index + match[0].length;
  }
  blocks.push(expanded.slice(from));
  for (const [claimIndex, block] of blocks.entries()) {
    // Paths locate evidence; their directory and component names are not code claims.
    const text = block.replace(CITATION, "").replace(new RegExp(CITATION_PATH, "g"), (path) => path.includes("/") ? "" : path);
    for (const match of block.matchAll(CITATION)) {
      const file = match[1]!.replace(/^\.\//, "");
      const identifiers = claimIdentifiers(text).filter((id) => !file.includes(id) && !id.includes(file.split("/").pop()!.replace(/\.[^.]+$/, "")));
      claims.push({ file, start:Number(match[2]), end:match[3] ? Number(match[3]) : Number(match[2]), identifiers, claimIndex });
    }
  }
  return claims;
}

function resolveRelative(from:string, target:string):string {
  const parts = from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** The targets a page does not link to, by relative links resolved from its own path. */
export function unlinkedPages(from:DocPage, targets:string[]):string[] {
  const linked = new Set([...withoutBacklinks(from.content).matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)].map((link) => resolveRelative(from.path, link[1]!)));
  return targets.filter((target) => !linked.has(target));
}

/**
 * Size findings for the oversized pages a unit may write. A page this pass made oversized blocks it; a page already
 * over the limit before the agent started is only reported. The lint never reads an oversized page, so the split the
 * repair round asked for exposed its whole content to a final check with no round left: Lane Pilot's 129 KB adoc
 * matrix, one row edited, became 786 findings (2026-10-18).
 */
export function oversizedPageFindings(oversized:string[], oversizedAtStart:string[]): { blocking:DocsFinding[]; kept:DocsFinding[] } {
  const before = new Set(oversizedAtStart);
  const finding = (path:string, detail:string):DocsFinding => ({ path, rule:"size", detail });
  return {
    blocking:oversized.filter((path) => !before.has(path)).map((path) => finding(path, "page is over 40000 bytes; split it into pages under 30000 bytes (a large data model into data-model/<area>.md pages) and link them")),
    kept:oversized.filter((path) => before.has(path)).map((path) => finding(path, "page was over 40000 bytes before this pass; the lint cannot read it, so split it in a pass of its own")),
  };
}

/** Files cited anywhere in the pages, for the line-count lookup the lint needs. */
export function citedFiles(pages:DocPage[]):string[] {
  return [...new Set(pages.flatMap((page) => pageCitations(page.content).map((citation) => citation.file)))].sort();
}

/** Marks the Referenced by block Lane Pilot writes, so the lint can tell it from one an agent wrote. */
export const BACKLINKS_MARK = "<!-- lane-pilot:backlinks -->";

export function withoutBacklinks(text:string):string {
  const at = text.indexOf(BACKLINKS_MARK);
  return at < 0 ? text : text.slice(0, at).replace(/\s+$/, "\n");
}
