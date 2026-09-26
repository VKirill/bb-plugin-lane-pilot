import { createHash } from "node:crypto";

export const DOCS_SINCE_CHOICES = ["yesterday", "24 hours ago", "7 days ago"] as const;
export type DocsSince = (typeof DOCS_SINCE_CHOICES)[number];

export type DocsMaintenanceSettings = {
  enabled: boolean;
  maintain: boolean;
  since: DocsSince;
  pageCap: number;
  hour: number;
};

export type DocsPage = { path:string; modifiedAt:number; sha256:string; content:string };
export type DocsEdit = { path:string; expectedSha256:string; content:string };

const DOC_ROOTS = ["docs/", "apps/"] as const;
const MAX_PAGE_BYTES = 40_000;

export function parseDocsSettings(raw:Record<string,unknown>):DocsMaintenanceSettings {
  const enabled = parseBoolean(raw["docs.enabled"], false, "docs.enabled");
  const maintain = parseBoolean(raw["docs.maintain"], true, "docs.maintain");
  const sinceValue = raw["docs.since"] ?? "yesterday";
  if (!(DOCS_SINCE_CHOICES as readonly unknown[]).includes(sinceValue)) throw new Error("docs.since must be yesterday, 24 hours ago, or 7 days ago");
  const pageCap = parseInteger(raw["docs.page_cap"], 0, 0, Number.MAX_SAFE_INTEGER, "docs.page_cap");
  const hour = parseInteger(raw["docs.hour"], 5, 0, 23, "docs.hour");
  return { enabled, maintain, since:sinceValue as DocsSince, pageCap, hour };
}

function parseBoolean(value:unknown, fallback:boolean, name:string):boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true" || value === "on" || value === "yes") return true;
  if (value === 0 || value === "0" || value === "false" || value === "off" || value === "no") return false;
  throw new Error(`${name} must be a boolean`);
}

function parseInteger(value:unknown, fallback:number, min:number, max:number, name:string):number {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

export function docsSinceEpoch(since:DocsSince, now:Date):number {
  if (since === "24 hours ago") return now.getTime() - 24 * 60 * 60 * 1000;
  if (since === "7 days ago") return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return yesterday.getTime();
}

export function docsScheduleDue(now:Date, hour:number, lastRunDate:string|null):boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("docs.hour must be an integer from 0 to 23");
  if (now.getHours() !== hour) return false;
  return lastRunDate !== localDateKey(now);
}

export function localDateKey(date:Date):string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function selectDocsPages(pages:DocsPage[], since:DocsSince, pageCap:number, now = new Date()):{pages:DocsPage[]; sinceEpoch:number; truncated:boolean} {
  if (!Number.isSafeInteger(pageCap) || pageCap < 0) throw new Error("docs.page_cap must be a non-negative safe integer");
  const sinceEpoch = docsSinceEpoch(since, now);
  const eligible = pages.filter((page) => isDocsPath(page.path) && page.modifiedAt >= sinceEpoch && validPage(page))
    .sort((a,b) => a.path.localeCompare(b.path));
  const selected = pageCap === 0 ? eligible : eligible.slice(0, pageCap);
  return { pages:selected, sinceEpoch, truncated:selected.length < eligible.length };
}

export function validateDocsEdits(raw:unknown, selected:DocsPage[], pageCap:number):DocsEdit[] {
  if (!Array.isArray(raw)) throw new Error("docs output must be an array of edits");
  const allowed = new Map(selected.map((page) => [page.path, page.sha256]));
  if (pageCap > 0 && raw.length > pageCap) throw new Error("docs output exceeds docs.page_cap");
  const seen = new Set<string>();
  const edits:DocsEdit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("docs edit must be an object");
    const edit = item as Record<string,unknown>;
    if (Object.keys(edit).some((key) => !["path","expectedSha256","content"].includes(key))) throw new Error("docs edit contains unsupported fields");
    if (typeof edit.path !== "string" || !isDocsPath(edit.path)) throw new Error("docs edit path must be under docs/ or apps/");
    if (seen.has(edit.path)) throw new Error(`duplicate docs edit path: ${edit.path}`);
    seen.add(edit.path);
    const expectedSha256 = allowed.get(edit.path);
    if (!expectedSha256) throw new Error(`docs edit is outside the since/page-cap input set: ${edit.path}`);
    if (edit.expectedSha256 !== expectedSha256) throw new Error(`docs edit hash does not match observed input: ${edit.path}`);
    if (typeof edit.content !== "string" || Buffer.byteLength(edit.content, "utf8") > MAX_PAGE_BYTES) throw new Error(`docs edit content is invalid or too large: ${edit.path}`);
    edits.push({ path:edit.path, expectedSha256, content:edit.content });
  }
  return edits;
}

export function docsInputHash(pages:DocsPage[]):string {
  return createHash("sha256").update(JSON.stringify(pages.map(({path,modifiedAt,sha256}) => ({path,modifiedAt,sha256}))), "utf8").digest("hex");
}

export function docsMaintenancePrompt(input:{since:DocsSince; pages:DocsPage[]; pageCap:number; agent?:string}):string {
  return [
    `${input.agent?.trim() || "Documentation maintainer"}: maintain only the documentation pages included below. Return JSON: an array of {path, expectedSha256, content} edits; an unchanged page needs no edit.`,
    "Do not edit source, settings, memory, or any path outside docs/ and apps/. Do not invent facts or line references. Do not commit or publish.",
    `Since window: ${input.since}. Page cap: ${input.pageCap === 0 ? "unlimited" : input.pageCap}.`,
    ...input.pages.map((page) => `\n### ${page.path} (sha256 ${page.sha256})\n${page.content}`),
  ].join("\n");
}

function isDocsPath(path:string):boolean {
  return !path.startsWith("/") && !path.split(/[\\/]/).some((part) => part === ".." || part === ".")
    && DOC_ROOTS.some((root) => path.startsWith(root)) && /\.md$/i.test(path);
}

function validPage(page:DocsPage):boolean {
  return Number.isSafeInteger(page.modifiedAt) && page.modifiedAt >= 0
    && /^[a-f0-9]{64}$/.test(page.sha256) && typeof page.content === "string"
    && Buffer.byteLength(page.content, "utf8") <= MAX_PAGE_BYTES;
}

/** Most changed paths listed to the nightly agent; it reads the code itself. */
const NIGHTLY_CHANGED_LIMIT = 200;

/**
 * Paths the nightly docs agent may write for one docs folder: the root docs/ with README.md and PROJECT.md,
 * or only its own <workspace>/docs/ in a monorepo. Lane Pilot reverts anything else it changes.
 */
export const nightlyDocsWritable = (docsDir = "docs") => (path:string):boolean =>
  path.startsWith(`${docsDir}/`) || (docsDir === "docs" && (path === "README.md" || path === "PROJECT.md"));

/** One docs folder of a project: the root docs/, or a monorepo workspace's own docs. */
export type DocsUnit = {
  docsDir:string;
  /** Set for a workspace's docs: its folder and package name. */
  workspace?:{ path:string; name:string };
  /** For the root docs of a monorepo: every workspace, and its docs folder when it keeps its own. */
  workspaces?:Array<{ path:string; name:string; docsDir:string | null }>;
};

const METHODOLOGY = [
  "Method (docs-methodology skill from claude-lane; read ~/.agents/skills/docs-methodology/SKILL.md and its references/ first if the file exists):",
  "- Every docs page starts with YAML frontmatter: title, type, created, updated (YYYY-MM-DD), status (draft|active|stale|deprecated), confidence (high|medium|low, honest: low under 5 sources, medium 5-15, high over 15), tags (kebab-case list), sources (list of files actually read, most relevant first).",
  "- type is one of overview, architecture, data-model, decisions, deployment, gotchas, gaps, active-areas, active-tasks, component, flow. One H1 equal to title, then a one-line TL;DR.",
  "- Write so an agent can learn how the product works from the docs alone, without opening the code. A component page has: Purpose; How it works - the steps in order as a numbered list, a table of the modes, variants or states it branches on (what differs between them: inputs, limits, prices, outputs), and what happens on each failure; Business rules; Public API or commands; Gotchas. A flow page (docs/flows/) has: Trigger; How it works - each step across apps and packages in order, naming the app, the call and the state it changes; Modes; Failures and compensation; Related pages. Depth follows the code: a large capability gets a long page or several pages, not a summary.",
  "- Every non-trivial claim cites file:line or file:start-end that exists; at least 3 citations per page. No hedges (typically, usually, should) without a citation, no marketing words (powerful, seamless, robust, comprehensive, intuitive, leverage), no dates in prose.",
  "- Keep each page under 30000 bytes: split a large subject into linked pages (a data model with many tables into data-model/<area>.md, one page per area, with data-model.md as the overview).",
  "- Link pages with relative paths. Never write an index.md in a docs folder or a 'Referenced by' section: Lane Pilot builds them.",
  "- Everything in English. Root README.md is the short front page for people: what it is, what it does, quick start, and links into docs/ - no detail that docs/ already holds. Root PROJECT.md is for agents: dense facts (Identity, Entry points, Critical invariants, Conventions, Common gotchas, Useful commands), each linking to the page that owns it.",
  "- One owner per fact: a value, limit, rule or command is stated on the one page that owns it (a table in data-model, a limit in its feature page) and other pages link there instead of repeating it. Lane Pilot checks claims that cite the same code across pages for contradictions.",
];

/**
 * The nightly docs agent works in the project folder with file access, like claude-lane's
 * docs-maintain: no docs/ yet means onboarding, otherwise only pages about changed code.
 */
export function nightlyDocsPrompt(input:{since:DocsSince; hasDocs:boolean; changed:string[]; refresh?:string[]; anchorsPath?:string; deploy?:boolean;
  missingPages?:string[]; uncoveredCore?:string[]; agent?:string; unit?:DocsUnit; flowsPath?:string}):string {
  const listed = input.changed.slice(0, NIGHTLY_CHANGED_LIMIT);
  const refresh = input.refresh ?? [];
  const unit = input.unit ?? { docsDir:"docs" };
  const d = unit.docsDir;
  const ws = unit.workspace;
  const own = unit.workspaces?.filter((item) => item.docsDir) ?? [];
  const shared = unit.workspaces?.filter((item) => !item.docsDir) ?? [];
  const scope = ws ? [
    `Scope: this is the workspace ${ws.name} (${ws.path}/) of a monorepo. Document only this workspace, in ${d}/. The root docs/ describe the whole system (architecture, deployment, cross-cutting gotchas) and other workspaces have their own docs: link there (for example ${relativeFrom(d, "docs/architecture.md")}) instead of repeating them.`,
    `Cite files by their path from the repository root (${ws.path}/src/...:12), as every docs page in this repository does.`,
  ] : own.length || shared.length ? [
    "Scope: this is the root of a monorepo. docs/ describes the system as a whole: what each app and package is for, how they talk, the data they share, how it is built and deployed, and cross-cutting gotchas.",
    ...(own.length ? ["These workspaces keep their own docs, written by their own passes - link to their overview and do not repeat their internals:", ...own.map((item) => `- ${item.name}: ${item.docsDir}/overview.md`)] : []),
    ...(shared.length ? ["These workspaces are small and belong to the root docs: describe each in docs/packages.md (component), one section per package with its purpose, public API and who uses it:", ...shared.map((item) => `- ${item.name} (${item.path}/)`)] : []),
    "The code map lists every workspace, which workspaces it uses, its build and run scripts, the compose services and the turbo tasks: docs/deployment.md explains how each app is built, configured, run and deployed, and docs/architecture.md has a mermaid graph of which apps use which packages.",
  ] : [];
  const flows = input.flowsPath ? ["",
    `Flows: Lane Pilot traced the business processes through the code for you in ${input.flowsPath} - each process, the entry points in the apps that drive it (routes, bot commands, jobs, pages) and an import chain from each entry into the process. Write docs/flows/<name>.md (flow) for every flow it lists: follow the chains in the code and describe the process end to end, step by step across the apps, with its modes and failures, linking to the feature pages of the packages it crosses. docs/overview.md links every flow.`] : [];
  return [
    `${input.agent?.trim() || "Documentation maintainer"}: keep this project's documentation an honest, evidence-backed description of its code.`,
    "",
    ...METHODOLOGY,
    ...(scope.length ? ["", ...scope] : []),
    ...flows,
    ...(input.anchorsPath ? ["",
      `Code map: Lane Pilot mapped this project for you in ${input.anchorsPath} - every declaration with its file:line, which ones Jev marked as business-rule candidates and entry points, the page each belongs to, dependencies and tests. Read it first, build pages around its anchors and cite them; confirm every business-rule candidate in the code before you describe it as a rule.`] : []),
    "",
    input.hasDocs
      ? [
        `Task: refresh the docs for code changed since ${input.since}. Update the pages below, set their updated date to today, keep created as is. Add a page only for a new capability; leave accurate pages alone.`,
        ...(refresh.length ? ["Pages whose sources changed or that are drafts:", ...refresh.map((path) => `- ${path}`)] : ["No page lists a changed file among its sources: check whether a changed file needs a new or extended page."]),
        ...(input.missingPages?.length ? ["Pages the method requires that do not exist yet - add them (data-model documents every table and its columns; architecture has one mermaid C4 diagram):", ...input.missingPages.map((path) => `- ${path}`)] : []),
        ...(input.uncoveredCore?.length ? ["Core behaviour and routes no page cites yet - describe them on the page they belong to, with citations:", ...input.uncoveredCore.slice(0, 120).map((item) => `- ${item}`),
          ...(input.uncoveredCore.length > 120 ? [`- …and ${input.uncoveredCore.length - 120} more; the next pass lists them`] : [])] : []),
      ].join("\n")
      : ws ? [
        `Task: there is no ${d}/ yet, so onboard this workspace. Create:`,
        `- ${d}/overview.md (overview): what the workspace does, how it starts or is used, its public API or entry points, its configuration, and which workspaces depend on it.`,
        `- ${d}/features/<capability>.md (component), one per capability it provides, with the sections the method lists (How it works with steps, modes and failures). A small library may need none beyond the overview.`,
        `- ${d}/api.md (component) when the code map lists routes or bot commands: every route grouped by area - method, path, who calls it, what it does, auth - linking to the feature page that explains it.`,
        `- ${d}/data-model.md (data-model) when this workspace defines stored data: every table or collection with its fields, keys and who writes it.`,
        `- ${d}/gotchas.md (gotchas) with the traps you find in this workspace's code, if there are any.`,
      ].join("\n")
      : [
        "Task: there is no docs/ yet, so onboard the project. Create:",
        "- docs/overview.md (overview): what the project is, how it is built and run, its main parts.",
        "- docs/architecture.md (architecture): parts and how they talk, with one mermaid C4 container or component diagram of at most 12 nodes.",
        "- docs/features/<capability>.md (component), one per user-facing capability, with the sections the method lists (How it works with steps, modes and failures).",
        "- docs/api.md (component) when the code map lists routes or commands: every route grouped by area, with method, path, caller, purpose and auth.",
        "- docs/data-model.md (data-model) when the code stores data: every table or collection with its fields, keys and who writes it.",
        ...(input.deploy ? ["- docs/deployment.md (deployment): how to install dependencies, build, test, install and configure it, as runnable steps taken from the scripts."] : []),
        "- docs/gotchas.md (gotchas) with the traps you find in the code; docs/decisions.md (decisions, ADR: Context, Decision, Status, Consequences) only for decisions the code or history shows.",
        "- README.md (the short front page for people) and PROJECT.md (for agents) at the project root; keep facts already in README.md, but move detail into docs/ and link to it.",
      ].join("\n"),
    "",
    `Read the code before writing about it. Write only ${ws ? `${d}/**` : "docs/**, README.md and PROJECT.md"}; do not edit code, tests, settings or other docs folders, and do not commit. Lane Pilot reverts changes anywhere else, checks the pages, builds ${d}/index.md and commits.`,
    "Finish with a short list of the pages you created or changed.",
    ...(listed.length ? ["", `Changed since ${input.since}:`, ...listed.map((path) => `- ${path}`)] : []),
    ...(input.changed.length > listed.length ? [`- …and ${input.changed.length - listed.length} more (see git log)`] : []),
  ].join("\n");
}

/** One repair round: the checks the pages failed, to fix without touching anything else. */
export function docsRepairPrompt(findings:Array<{ path:string; rule:string; detail:string }>):string {
  return [
    "Lane Pilot checked the docs and found these problems. Fix exactly these, following the same method; change nothing else.",
    ...findings.slice(0, 80).map((finding) => `- ${finding.path} [${finding.rule}]: ${finding.detail}`),
    ...(findings.length > 80 ? [`- …and ${findings.length - 80} more of the same kinds`] : []),
  ].join("\n");
}

function relativeFrom(docsDir:string, target:string):string {
  return `${docsDir.split("/").map(() => "..").join("/")}/${target}`;
}
