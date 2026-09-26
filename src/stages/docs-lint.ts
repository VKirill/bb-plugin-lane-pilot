/**
 * Deterministic checks for docs written by the nightly docs agent, after the docs-methodology
 * skill (claude-lane): frontmatter contract, file:line evidence that points at real lines,
 * no marketing words, links that resolve, and the pages only builders may write.
 */

export const DOC_PAGE_TYPES = ["overview", "architecture", "data-model", "decisions", "deployment", "gotchas", "gaps",
  "active-areas", "active-tasks", "component", "index"] as const;
const STATUSES = ["draft", "active", "stale", "deprecated"];
const CONFIDENCE = ["high", "medium", "low"];
const REQUIRED = ["title", "type", "created", "updated", "status", "confidence", "tags", "sources"];
const MIN_CITATIONS = 3;
/** English marketing words the methodology forbids in wiki pages. */
const MARKETING = ["leverage", "leverages", "powerful", "seamless", "seamlessly", "robust", "comprehensive", "intuitive",
  "cutting-edge", "state-of-the-art", "enterprise-grade"];
const CITATION = /([A-Za-z0-9_@.\/-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;

export type DocPage = { path:string; content:string };
export type Frontmatter = Record<string, string | string[]>;
export type DocsFinding = { path:string; rule:string; detail:string };

/** The YAML subset the contract uses: scalars, `[a, b]` lists and `- item` lists. */
export function parseFrontmatter(content:string): { data:Frontmatter; body:string } | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!match) return null;
  const data:Frontmatter = {};
  let listKey:string | null = null;
  for (const raw of match[1]!.split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) { (data[listKey] as string[]).push(unquote(item[1]!)); continue; }
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!field) continue;
    const [, key, value] = field as unknown as [string, string, string];
    if (value === "") { data[key] = []; listKey = key; continue; }
    listKey = null;
    const inline = /^\[(.*)\]$/.exec(value.trim());
    data[key] = inline ? inline[1]!.split(",").map((part) => unquote(part.trim())).filter(Boolean) : unquote(value.trim());
  }
  return { data, body:content.slice(match[0].length) };
}

function unquote(value:string):string {
  return value.replace(/^["']|["']$/g, "");
}

/** Citations in a page body that name a file and a line, with the file relative to the project root. */
export function pageCitations(body:string): Array<{ file:string; start:number; end:number }> {
  const found:Array<{ file:string; start:number; end:number }> = [];
  for (const match of body.matchAll(CITATION)) {
    const start = Number(match[2]), end = match[3] ? Number(match[3]) : start;
    found.push({ file:match[1]!.replace(/^\.\//, ""), start, end });
  }
  return found;
}

/**
 * Checks every page but the builder-owned index. `lineCounts` maps each cited file to its number of
 * lines, or null when the file does not exist.
 */
export function lintDocsPages(pages:DocPage[], lineCounts:Record<string, number | null>): DocsFinding[] {
  const findings:DocsFinding[] = [];
  const paths = new Set(pages.map((page) => page.path));
  for (const page of pages) {
    if (!page.path.startsWith("docs/") || page.path === "docs/index.md") continue;
    const add = (rule:string, detail:string) => findings.push({ path:page.path, rule, detail });
    const parsed = parseFrontmatter(page.content);
    if (!parsed) { add("frontmatter", "page must start with a YAML frontmatter block"); continue; }
    const { data, body } = parsed;
    for (const key of REQUIRED) if (data[key] === undefined || data[key] === "" || (Array.isArray(data[key]) && !data[key]!.length)) add("frontmatter", `missing ${key}`);
    if (typeof data.type === "string" && !(DOC_PAGE_TYPES as readonly string[]).includes(data.type)) add("frontmatter", `type must be one of ${DOC_PAGE_TYPES.join(", ")}`);
    if (typeof data.status === "string" && !STATUSES.includes(data.status)) add("frontmatter", `status must be one of ${STATUSES.join(", ")}`);
    if (typeof data.confidence === "string" && !CONFIDENCE.includes(data.confidence)) add("frontmatter", `confidence must be one of ${CONFIDENCE.join(", ")}`);
    const h1 = body.split("\n").filter((line) => /^# /.test(line));
    if (h1.length !== 1) add("structure", `page needs exactly one H1, found ${h1.length}`);
    else if (typeof data.title === "string" && h1[0]!.slice(2).trim() !== data.title) add("structure", "H1 must match the frontmatter title");
    if (/^## Referenced by/m.test(body)) add("builder", "do not write a Referenced by section; the backlinks builder owns it");
    const citations = pageCitations(body);
    if (citations.length < MIN_CITATIONS) add("evidence", `needs at least ${MIN_CITATIONS} file:line citations, found ${citations.length}`);
    for (const citation of citations) {
      const lines = lineCounts[citation.file];
      if (lines === undefined) continue;
      if (lines === null) add("evidence", `cites ${citation.file}, which does not exist`);
      else if (citation.end > lines || citation.start < 1 || citation.start > citation.end) add("evidence", `cites ${citation.file}:${citation.start}${citation.end !== citation.start ? `-${citation.end}` : ""}, but the file has ${lines} lines`);
    }
    for (const word of MARKETING) if (new RegExp(`\\b${word}\\b`, "i").test(body)) add("wording", `marketing word "${word}"`);
    for (const link of body.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      const target = link[1]!;
      if (/^[a-z]+:\/\//i.test(target)) continue;
      const resolved = resolveRelative(page.path, target);
      if (resolved.startsWith("docs/") && !paths.has(resolved)) add("links", `link ${target} points at a page that does not exist`);
    }
  }
  return findings;
}

function resolveRelative(from:string, target:string):string {
  const parts = from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** Files cited anywhere in the pages, for the line-count lookup the lint needs. */
export function citedFiles(pages:DocPage[]):string[] {
  return [...new Set(pages.flatMap((page) => pageCitations(page.content).map((citation) => citation.file)))].sort();
}

/** Pages to refresh tonight: those whose sources include changed code, and draft pages. */
export function pagesToRefresh(pages:DocPage[], changed:string[]):string[] {
  const touched = new Set(changed);
  return pages.filter((page) => {
    if (!page.path.startsWith("docs/") || page.path === "docs/index.md") return false;
    const data = parseFrontmatter(page.content)?.data;
    if (!data) return true;
    const sources = Array.isArray(data.sources) ? data.sources : [];
    return data.status === "draft" || sources.some((source) => touched.has(source.replace(/:\d+(-\d+)?$/, "")));
  }).map((page) => page.path).sort();
}

/** docs/index.md, built from the frontmatter of every other page; the model never writes it. */
export function buildDocsIndex(pages:DocPage[]):string {
  const rows = pages
    .filter((page) => page.path.startsWith("docs/") && page.path !== "docs/index.md")
    .map((page) => ({ path:page.path, data:parseFrontmatter(page.content)?.data ?? {} }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const lines = ["---", "title: Documentation index", "type: index", "status: active", "---", "", "# Documentation index", "",
    "Built by Lane Pilot from page frontmatter.", "", "| Page | Type | Status | Updated |", "|---|---|---|---|"];
  for (const row of rows) {
    const title = typeof row.data.title === "string" ? row.data.title : row.path;
    const cell = (key:string) => typeof row.data[key] === "string" ? row.data[key] as string : "—";
    lines.push(`| [${title.replace(/\|/g, "\\|")}](${row.path.slice("docs/".length)}) | ${cell("type")} | ${cell("status")} | ${cell("updated")} |`);
  }
  return `${lines.join("\n")}\n`;
}
