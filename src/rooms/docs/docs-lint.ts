/**
 * Deterministic checks for docs written by the nightly docs agent, after the docs-methodology
 * skill (claude-lane): frontmatter contract, file:line evidence that points at real lines,
 * no marketing words, links that resolve, and the pages only builders may write.
 */

export const DOC_PAGE_TYPES = ["overview", "architecture", "data-model", "decisions", "deployment", "gotchas", "gaps",
  "active-areas", "active-tasks", "component", "flow", "capabilities", "audience", "index"] as const;
/** Page types that describe behaviour and must say how it works, not only what exists. */
const HOW_IT_WORKS_TYPES = ["component", "flow"];
const STATUSES = ["draft", "active", "stale", "deprecated"];
const CONFIDENCE = ["high", "medium", "low"];
const REQUIRED = ["title", "type", "created", "updated", "status", "confidence", "tags", "sources"];
const MIN_CITATIONS = 3;
/** A flow crosses several apps and packages; fewer citations than this means a summary, not the process. */
const MIN_FLOW_CITATIONS = 15;
/** English marketing words the methodology forbids in wiki pages. */
const MARKETING = ["leverage", "leverages", "powerful", "seamless", "seamlessly", "robust", "comprehensive", "intuitive",
  "cutting-edge", "state-of-the-art", "enterprise-grade"];
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
const isDocsContent = (path:string):boolean => isDocsPage(path) && !isDocsIndex(path) && !isDesignCanon(path);
const docsDirOf = (path:string):string => /^(.*?(?:^|\/)?docs)\//.exec(path)?.[1] ?? "";
export type Frontmatter = Record<string, string | string[]>;
/** `target` names the page a finding is about when that is another page: a link's target. */
export type DocsFinding = { path:string; rule:string; detail:string; target?:string };

/**
 * The YAML subset the contract uses: scalars, `[a, b]` lists and `- item` lists, indented or not. YAML allows a list
 * under a key at the key's own indent (PyYAML writes it so); read as empty, such a page was "missing tags" every night
 * while the agent's YAML parser saw them, so the pass never landed (treba, 2026-10-15..17).
 */
export function parseFrontmatter(content:string): { data:Frontmatter; body:string } | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!match) return null;
  const data:Frontmatter = {};
  let listKey:string | null = null;
  for (const raw of match[1]!.split("\n")) {
    const item = /^[ \t]*-[ \t]+(.*)$/.exec(raw);
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

/**
 * Checks every page but the builder-owned index. `lineCounts` maps each cited file to its number of
 * lines, or null when the file does not exist. `present` names pages that exist but are not in `pages`
 * (too large to read): links to them resolve, the size check reports them.
 */
export function lintDocsPages(pages:DocPage[], lineCounts:Record<string, number | null>, present:string[] = []): DocsFinding[] {
  const findings:DocsFinding[] = [];
  const paths = new Set([...pages.map((page) => page.path), ...present]);
  for (const page of pages) {
    if (!isDocsContent(page.path)) continue;
    const add = (rule:string, detail:string, target?:string) => findings.push({ path:page.path, rule, detail, ...(target ? { target } : {}) });
    // A broken frontmatter must not hide the page's other findings: the repair round is the only one, so what it is not
    // told fails the pass (treba, 2026-10-22: an agent's script glued the closing '---' to the last field; once the
    // round fixed that, 4 pages it had switched to type component lacked '## How it works'). A glued block is read as
    // written; a page with none is checked by its body.
    const strict = parseFrontmatter(page.content);
    const glued = strict ? null : /^---\n([\s\S]*?)---[ \t]*\n/.exec(page.content);
    const parsed = strict ?? (glued ? parseFrontmatter(`---\n${glued[1]}\n---\n${page.content.slice(glued[0].length)}`) : null);
    if (!strict) add("frontmatter", parsed
      ? `the frontmatter's closing '---' must be on a line of its own, not at the end of "${glued![1]!.split("\n").pop()!.trim()}---"`
      : "page must start with a YAML frontmatter block");
    const { data, body } = parsed ?? { data:{} as Frontmatter, body:page.content };
    // The main page of a flow carries the process; the part pages it splits into are held to the general rules.
    const mainFlow = data.type === "flow" && /(^|\/)docs\/flows\/[^/]+\.md$/.test(page.path);
    if (parsed) for (const key of REQUIRED) if (data[key] === undefined || data[key] === "" || (Array.isArray(data[key]) && !data[key]!.length)) add("frontmatter", `missing ${key}`);
    if (typeof data.type === "string" && !(DOC_PAGE_TYPES as readonly string[]).includes(data.type)) add("frontmatter", `type must be one of ${DOC_PAGE_TYPES.join(", ")}`);
    if (typeof data.status === "string" && !STATUSES.includes(data.status)) add("frontmatter", `status must be one of ${STATUSES.join(", ")}`);
    if (typeof data.confidence === "string" && !CONFIDENCE.includes(data.confidence)) add("frontmatter", `confidence must be one of ${CONFIDENCE.join(", ")}`);
    const h1 = withoutCodeBlocks(body).split("\n").filter((line) => /^# /.test(line));
    if (h1.length !== 1) add("structure", `page needs exactly one H1, found ${h1.length}`);
    else if (typeof data.title === "string" && h1[0]!.slice(2).trim() !== data.title) add("structure", "H1 must match the frontmatter title");
    // A component page covering several operations may give each its own '### How it works'; a flow's steps stay one section.
    const howItWorks = data.type === "component" ? /^#{2,3} How it works\b/m : /^## How it works\b/m;
    if (typeof data.type === "string" && HOW_IT_WORKS_TYPES.includes(data.type) && (data.type !== "flow" || mainFlow) && !howItWorks.test(body)) add("structure", "a component or flow page needs a '## How it works' section (on a component page covering several operations, a '### How it works' under each): the steps in order, the modes and states it branches on, and what happens on failure");
    if (/^## Referenced by/m.test(withoutBacklinks(body))) add("builder", "do not write a Referenced by section; the backlinks builder owns it");
    const citations = pageCitations(body);
    const least = mainFlow ? MIN_FLOW_CITATIONS : MIN_CITATIONS;
    if (citations.length < least) add("evidence", `needs at least ${least} file:line citations, found ${citations.length}`);
    if (data.type === "data-model" && !/erDiagram|^## Relations\b/m.test(body)) add("structure", "a data-model page needs a mermaid erDiagram or a '## Relations' section: which tables reference which, by which keys");
    if (data.type === "data-model" && /^\|/m.test(body) && !/^\|[^\n]*\bMeaning\b/m.test(body)) add("structure", "a data-model field table needs a Meaning column: what the field means, its allowed values and units - the schema already has the types");
    if (mainFlow && !/^## Capabilities\b/m.test(body)) add("structure", "a flow page needs a '## Capabilities' section: what a user or operator can do in this process - each mode and option, formats, limits, costs and where it is available - each cited");
    // Evidence is the code: Lane Pilot's own working files and other docs pages are not.
    for (const file of new Set(citations.map((citation) => citation.file))) {
      if (/^\.git\//.test(file) || isDocsPage(file) || /(^|\/)(README|PROJECT)\.md$/.test(file)) add("evidence", `cites ${file}; cite the code itself and link docs pages instead`);
    }
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
      // A link into another workspace's docs may point at a page that folder's own pass is still writing: a warning, not a block.
      if (isDocsPage(resolved) && !paths.has(resolved)) add(docsDirOf(resolved) === docsDirOf(page.path) ? "links" : "links-external", `link ${target} points at a page that does not exist`, resolved);
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

/** The targets a page does not link to, by relative links resolved from its own path. */
export function unlinkedPages(from:DocPage, targets:string[]):string[] {
  const linked = new Set([...withoutBacklinks(from.content).matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)].map((link) => resolveRelative(from.path, link[1]!)));
  return targets.filter((target) => !linked.has(target));
}

/**
 * The targets a catalogue does not link, counting the area pages under its own folder that it reaches by links
 * (docs/capabilities.md → docs/capabilities/<area>.md → docs/capabilities/<area>/<part>.md): a catalogue split to stay
 * under the size limit still covers what its area pages link, and so does an area page split again for the same reason.
 */
export function uncataloguedPages(catalogue:DocPage, pages:DocPage[], targets:string[]):string[] {
  const folder = `${catalogue.path.replace(/\.md$/, "")}/`;
  let unreached = pages.filter((page) => page.path.startsWith(folder));
  let left = unlinkedPages(catalogue, targets);
  for (let linking = [catalogue]; linking.length && left.length;) {
    const areas = unreached.filter((page) => linking.some((from) => !unlinkedPages(from, [page.path]).length));
    unreached = unreached.filter((page) => !areas.includes(page));
    left = areas.reduce((rest, area) => unlinkedPages(area, rest), left);
    linking = areas;
  }
  return left;
}

/**
 * The findings that block a docs pass: those on a page the pass wrote, or about a page it wrote
 * (a link to a page it removed or moved).
 * Pages it did not touch are already on main as they are; holding the pass to them blocks every
 * night on a docs folder that predates the method and never lands what the pass did write.
 */
export function blockingDocsFindings<T extends DocsFinding>(findings:T[], written:string[]):T[] {
  const mine = new Set(written);
  return findings.filter((finding) => mine.has(finding.path) || (finding.target !== undefined && mine.has(finding.target)));
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

/** Pages to refresh tonight: those whose sources include changed code, and draft pages. */
export function pagesToRefresh(pages:DocPage[], changed:string[]):string[] {
  const touched = new Set(changed);
  return pages.filter((page) => {
    if (!isDocsContent(page.path)) return false;
    const data = parseFrontmatter(page.content)?.data;
    if (!data) return true;
    const sources = Array.isArray(data.sources) ? data.sources : [];
    return data.status === "draft" || sources.some((source) => touched.has(source.replace(/:\d+(-\d+)?$/, "")));
  }).map((page) => page.path).sort();
}

/**
 * <docsDir>/index.md, built from the frontmatter of every other page in that folder; the model never writes it.
 * The root index of a monorepo also links each workspace's own docs index.
 */
export function buildDocsIndex(pages:DocPage[], docsDir = "docs", workspaces:Array<{ name:string; docsDir:string }> = []):string {
  const rows = pages
    .filter((page) => page.path.startsWith(`${docsDir}/`) && isDocsContent(page.path))
    .map((page) => ({ path:page.path, data:parseFrontmatter(page.content)?.data ?? {} }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const lines = ["---", "title: Documentation index", "type: index", "status: active", "---", "", "# Documentation index", "",
    "Built by Lane Pilot from page frontmatter.", "", "| Page | Type | Status | Updated |", "|---|---|---|---|"];
  for (const row of rows) {
    const title = typeof row.data.title === "string" ? row.data.title : row.path;
    const cell = (key:string) => typeof row.data[key] === "string" ? row.data[key] as string : "—";
    lines.push(`| [${title.replace(/\|/g, "\\|")}](${row.path.slice(docsDir.length + 1)}) | ${cell("type")} | ${cell("status")} | ${cell("updated")} |`);
  }
  if (workspaces.length) {
    lines.push("", "## Workspace docs", "", "| Workspace | Docs |", "|---|---|");
    for (const workspace of workspaces) lines.push(`| ${workspace.name} | [${workspace.docsDir}/](${relativeLink(`${docsDir}/index.md`, `${workspace.docsDir}/index.md`)}) |`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What keeps the docs from being complete: pages the methodology requires that no page's type fills,
 * and core code no citation covers. The nightly agent gets both as its task list.
 */
export function docsCompletenessGaps(pages:DocPage[], input:{ tables:string[]; deploy?:boolean; core:Array<{ name:string; file:string; line:number; endLine:number }>; docsDir?:string; workspace?:boolean; flows?:string[] }):{ missingPages:string[]; uncoveredCore:string[] } {
  const docsDir = input.docsDir ?? "docs";
  const types = new Set(pages.map((page) => parseFrontmatter(page.content)?.data.type).filter((type):type is string => typeof type === "string"));
  // A workspace inherits architecture, gotchas and deployment from the root docs and needs only its own overview.
  const required:Array<[string, string]> = input.workspace ? [["overview", `${docsDir}/overview.md`]]
    : [["overview", `${docsDir}/overview.md`], ["architecture", `${docsDir}/architecture.md`], ["gotchas", `${docsDir}/gotchas.md`]];
  if (input.tables.length) required.push(["data-model", `${docsDir}/data-model.md`]);
  if (input.deploy) required.push(["deployment", `${docsDir}/deployment.md`]);
  if (input.flows?.length) required.push(["capabilities", `${docsDir}/capabilities.md`]);
  // The root of a product gets an entry page per role: what each reads, in which order, and the facts that matter to it.
  if (!input.workspace && input.flows?.length) required.push(...["copy", "seo", "design"].map((role) => ["audience", `${docsDir}/audiences/${role}.md`] as [string, string]));
  const paths = new Set(pages.map((page) => page.path));
  const missingPages = required.filter(([type, path]) => type === "audience" ? !paths.has(path) : !types.has(type)).map(([, path]) => path);
  const citations = pages.flatMap((page) => pageCitations(page.content));
  const uncoveredCore = input.core.filter((anchor) => !citations.some((citation) => citation.file === anchor.file
    && citation.start <= anchor.endLine && citation.end >= anchor.line)).map((anchor) => `${anchor.name} (${anchor.file}:${anchor.line}-${anchor.endLine})`);
  return { missingPages, uncoveredCore };
}

/** Marks the Referenced by block Lane Pilot writes, so the lint can tell it from one an agent wrote. */
export const BACKLINKS_MARK = "<!-- lane-pilot:backlinks -->";

export function withoutBacklinks(text:string):string {
  const at = text.indexOf(BACKLINKS_MARK);
  return at < 0 ? text : text.slice(0, at).replace(/\s+$/, "\n");
}

/** Every docs page with its Referenced by block rebuilt from the relative links of the other pages. */
export function buildBacklinks(pages:DocPage[]):Array<{ path:string; content:string }> {
  const docs = pages.filter((page) => isDocsContent(page.path));
  const inbound = new Map<string, Set<string>>();
  for (const page of docs) {
    for (const link of withoutBacklinks(page.content).matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:\/\//i.test(link[1]!)) continue;
      const target = resolveRelative(page.path, link[1]!);
      if (target !== page.path) inbound.set(target, new Set([...(inbound.get(target) ?? []), page.path]));
    }
  }
  const title = (path:string) => {
    const data = parseFrontmatter(docs.find((page) => page.path === path)?.content ?? "")?.data;
    return typeof data?.title === "string" ? data.title : path;
  };
  return docs.map((page) => {
    const from = [...(inbound.get(page.path) ?? [])].sort();
    const base = withoutBacklinks(page.content);
    if (!from.length) return { path:page.path, content:base };
    const links = from.map((source) => `- [${title(source)}](${relativeLink(page.path, source)})`);
    return { path:page.path, content:`${base.replace(/\n*$/, "\n")}\n${BACKLINKS_MARK}\n## Referenced by\n\n${links.join("\n")}\n` };
  });
}

function relativeLink(from:string, to:string):string {
  const a = from.split("/").slice(0, -1), b = to.split("/");
  let shared = 0;
  while (shared < a.length && shared < b.length - 1 && a[shared] === b[shared]) shared++;
  return [...a.slice(shared).map(() => ".."), ...b.slice(shared)].join("/");
}

/**
 * confidence from what was verified, not from a source count: the share of a page's claims Jev found
 * backed by the cited code, a claim the code backs in part counting half. A draft verified to at least
 * medium becomes active; a low one stays a draft, so the next pass rewrites it.
 */
export function withVerifiedConfidence(content:string, verified:{ checked:number; supported:number; partial?:number }):string {
  if (verified.checked === 0) return content;
  const share = (verified.supported + (verified.partial ?? 0) / 2) / verified.checked;
  const level = share >= 0.85 && verified.checked >= 10 ? "high" : share >= 0.6 ? "medium" : "low";
  const rated = content.replace(/^(---\n[\s\S]*?^confidence:\s*)\S+/m, `$1${level}`);
  return level === "low" ? rated : rated.replace(/^(---\n[\s\S]*?^status:\s*)draft\b/m, "$1active");
}

/** sources with every cited file added, so staleness finds the page when any of them changes. */
export function withCitedSources(content:string):string {
  const parsed = parseFrontmatter(content);
  if (!parsed) return content;
  const listed = new Set((Array.isArray(parsed.data.sources) ? parsed.data.sources : []).map((source) => source.replace(/:\d+(-\d+)?$/, "")));
  const missing = [...new Set(pageCitations(withoutBacklinks(parsed.body)).map((citation) => citation.file))].filter((file) => !listed.has(file));
  if (!missing.length) return content;
  // New entries take the indent of the list already there, so the list stays one YAML sequence.
  return content.replace(/^(---\n[\s\S]*?^sources:[^\n]*\n)((?:[ \t]*-[ \t]+[^\n]*\n)*)/m, (_, head:string, items:string) => {
    const indent = /^([ \t]*)-/.exec(items)?.[1] ?? "  ";
    return `${head}${items}${missing.map((file) => `${indent}- ${file}\n`).join("")}`;
  });
}
