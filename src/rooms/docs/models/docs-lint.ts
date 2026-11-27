/**
 * Deterministic checks for docs written by the nightly docs agent, after the docs-methodology
 * skill (claude-lane): frontmatter contract, file:line evidence that points at real lines,
 * no marketing words, links that resolve, and the pages only builders may write.
 */

/**
 * A cited path: letters, digits and `_@.[]+-` in a name (Nuxt's `[slug].get.ts`, Expo's `ask+api.ts`), and a route group
 * `(tabs)` only as a whole folder followed by `/`, so a citation in parentheses keeps its own `(`.
 */
const CITATION_PATH = String.raw`(?:[A-Za-z0-9_@.\/\[\]+-]|\([A-Za-z0-9_@.\[\]+-]+\)(?=\/))+\.[A-Za-z][A-Za-z0-9]*`;
/** `path:line` or `path:start-end`; groups: the path, the first line, the last line. */
export const CITATION_SOURCE = String.raw`(${CITATION_PATH}):(\d+)(?:-(\d+))?`;
const CITATION = new RegExp(CITATION_SOURCE, "g");

export type DocPage = { path:string; content:string };

/** `target` names the page a finding is about when that is another page: a link's target. */
export type DocsFinding = { path:string; rule:string; detail:string; target?:string };

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

/** Marks the Referenced by block Lane Pilot writes, so the lint can tell it from one an agent wrote. */
export const BACKLINKS_MARK = "<!-- lane-pilot:backlinks -->";

export function withoutBacklinks(text:string):string {
  const at = text.indexOf(BACKLINKS_MARK);
  return at < 0 ? text : text.slice(0, at).replace(/\s+$/, "\n");
}
