import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

/**
 * Jev (TypeSafe System One) as the documentation pipeline's judgment layer. Code finds candidates -
 * declarations, citations, diffs - and Jev only judges them with typed answers: is this a business
 * rule, an entry point, which page it belongs to, does this code back that claim, does this diff
 * change that section. Every function degrades to the deterministic path when Jev is unavailable.
 */

const run = promisify(execFile);
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** Jev takes about 32k tokens of state; English code is roughly 4 characters a token. */
const JEV_STATE_CHARS = 100_000;
const JEV_CONCURRENCY = 8;
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;
const SKIP_PATH = /^(docs\/|dist\/|build\/|node_modules\/|\.agents\/|\.bb\/|\.claude\/|vendor\/)/;
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/;
const MAX_ANCHORS = 300;
const SNIPPET_LINES = 60;
const MAX_CITATION_CHECKS = 250;
/** Marks below this stay in the per-file list but not in the rule and entry-point lists. */
const MARK_THRESHOLD = 0.65;

export type JevStatus = "ok" | "partial" | "disabled";
type JevQuestion = { type:"noul" | "choice" | "score"; instructions:unknown; criteria?:unknown };
type JevAnswer = { noul?:number; choice?:string; probabilities?:Record<string, number>; score?:number; confidence?:number };

export async function jevApiKey(): Promise<string> {
  const fromEnv = (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const text = await readFile(join(homedir(), "secrets", "typesafe.env"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const match = /^\s*(TYPESAFE_API_KEY|JEV_API_KEY)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) return match[2]!.replace(/^['"]|['"]$/g, "");
  }
  return "";
}

/** Shrinks the longest strings until the state fits Jev's window; the head and tail of a text carry most of its meaning. */
export function boundJevState<T>(state:T, limit = JEV_STATE_CHARS): T {
  let copy = JSON.parse(JSON.stringify(state)) as unknown;
  for (let round = 0; round < 20 && JSON.stringify(copy).length > limit; round++) {
    const excess = JSON.stringify(copy).length - limit;
    let longest:{ holder:Record<string, unknown> | unknown[]; key:string | number; length:number } | null = null;
    const visit = (value:unknown, holder:Record<string, unknown> | unknown[] | null, key:string | number | null) => {
      if (typeof value === "string" && holder && key !== null && (!longest || value.length > longest.length)) longest = { holder, key, length:value.length };
      else if (Array.isArray(value)) value.forEach((item, index) => visit(item, value, index));
      else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) visit(item, value as Record<string, unknown>, name);
    };
    if (typeof copy === "string") { copy = shorten(copy, copy.length - excess - 64); continue; }
    visit(copy, null, null);
    if (!longest) break;
    const target = longest as { holder:Record<string, unknown> | unknown[]; key:string | number; length:number };
    const text = (target.holder as Record<string | number, unknown>)[target.key] as string;
    (target.holder as Record<string | number, unknown>)[target.key] = shorten(text, Math.max(200, text.length - excess - 64));
  }
  return copy as T;
}

function shorten(text:string, keep:number):string {
  if (text.length <= keep) return text;
  const head = Math.floor(keep * 0.7), tail = keep - head;
  return `${text.slice(0, head)}\n…[${text.length - keep} characters omitted]…\n${text.slice(text.length - tail)}`;
}

async function jevAsk(key:string, state:unknown, questions:Record<string, JevQuestion>, timeoutMs = 20_000):Promise<Record<string, JevAnswer> | null> {
  try {
    const response = await fetch(JEV_URL, {
      method:"POST",
      headers:{ authorization:`Bearer ${key}`, "content-type":"application/json" },
      body:JSON.stringify({ model:"jev-latest", state:boundJevState(state), questions }),
      signal:AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = await response.json() as { answers?:Record<string, JevAnswer> };
    return body.answers ?? null;
  } catch {
    return null;
  }
}

async function pool<T, R>(items:T[], work:(item:T) => Promise<R>):Promise<R[]> {
  const results:R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length:Math.min(JEV_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!); }
  }));
  return results;
}

const status = (asked:number, answered:number):JevStatus => answered === asked ? "ok" : answered === 0 && asked > 0 ? "disabled" : "partial";

// ---- anchors ------------------------------------------------------------------------------

export type Anchor = {
  name:string; kind:"function" | "class" | "type" | "const" | "table"; exported:boolean;
  file:string; line:number; endLine:number; snippet:string;
  businessRule?:number; userFacing?:number; projectSpecific?:number; importance?:number; page?:string;
};

const DECLARATIONS:Array<{ re:RegExp; kind:Anchor["kind"]; exported:boolean }> = [
  { re:/^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind:"function", exported:true },
  { re:/^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind:"class", exported:true },
  { re:/^export\s+(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind:"type", exported:true },
  { re:/^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/, kind:"const", exported:true },
  { re:/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind:"function", exported:false },
  { re:/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind:"function", exported:false },
  { re:/^class\s+([A-Za-z_$][\w$]*)/, kind:"class", exported:false },
  { re:/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind:"function", exported:true },
  { re:/^class\s+([A-Za-z_]\w*)\s*[(:]/, kind:"class", exported:true },
];

/** Declarations found line by line: a start is a top-level line matching a declaration, the body runs to the next one. */
export function scanDeclarations(file:string, text:string):Anchor[] {
  const lines = text.split("\n");
  const starts:Array<{ line:number; name:string; kind:Anchor["kind"]; exported:boolean }> = [];
  lines.forEach((line, index) => {
    for (const decl of DECLARATIONS) {
      const match = decl.re.exec(line);
      if (match?.[1]) { starts.push({ line:index + 1, name:match[1], kind:decl.kind, exported:decl.exported }); break; }
    }
    const table = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z_]\w*)/i.exec(line);
    if (table?.[1]) starts.push({ line:index + 1, name:table[1], kind:"table", exported:true });
  });
  return starts.map((start, index) => {
    const nextStart = starts.slice(index + 1).find((other) => other.kind !== "table" && other.line > start.line)?.line ?? lines.length + 1;
    const endLine = Math.min(nextStart - 1, start.line + SNIPPET_LINES - 1, lines.length);
    return { name:start.name, kind:start.kind, exported:start.exported, file, line:start.line, endLine,
      snippet:lines.slice(start.line - 1, endLine).join("\n").slice(0, 4000) };
  });
}

async function trackedCode(projectCwd:string):Promise<string[]> {
  const listed = (await run("git", ["-c", "core.quotePath=false", "-C", projectCwd, "ls-files"], { maxBuffer:32 << 20 })).stdout.split("\n");
  return listed.filter((path) => CODE_FILE.test(path) && !SKIP_PATH.test(path));
}

const ANCHOR_QUESTIONS = (pages:Array<{ path:string; title:string }>):Record<string, JevQuestion> => ({
  business_rule:{ type:"noul", instructions:"Does `code` enforce a rule of the product itself - a validation, a limit, a permission, a price, a state transition or a policy that a product owner would recognise - rather than plumbing, formatting or wiring?" },
  project_specific:{ type:"noul", instructions:"Is `code` specific to this project's product, rather than a generic UI-kit component, styling constant, framework glue or utility that could be copied unchanged into any app?" },
  user_facing:{ type:"noul", instructions:"Is `code` reached directly by a user or a client: a CLI command, an RPC or HTTP handler, a UI component, a scheduled job or the plugin's entry point?" },
  importance:{ type:"score", instructions:"How central is `code` to what this project does for its users?",
    criteria:["A small internal helper or type", "Supporting logic used by a feature", "Core behaviour of the product"] },
  ...(pages.length ? { page:{ type:"choice", instructions:"Which documentation page describes the behaviour of `code`?",
    criteria:{ ...Object.fromEntries(pages.slice(0, 250).map((page) => [page.path, page.title])), none:"No existing page covers it" } } } : {}),
});

async function dependencies(projectCwd:string):Promise<string[]> {
  const pkg = await readFile(join(projectCwd, "package.json"), "utf8").then((text) => JSON.parse(text) as Record<string, Record<string, string>>).catch(() => null);
  if (!pkg) return [];
  return [...Object.entries(pkg.dependencies ?? {}).map(([name, version]) => `${name}@${version}`),
    ...Object.entries(pkg.devDependencies ?? {}).map(([name, version]) => `${name}@${version} (dev)`)];
}

/**
 * Maps the project's code into anchors, has Jev mark business rules, entry points, importance and
 * page, and writes the brief the docs agent starts from under .git/, outside anything git tracks.
 */
export async function buildDocsAnchors(input:{ projectCwd:string; pages:Array<{ path:string; title:string }> }):Promise<{ briefPath:string; anchors:number; jev:JevStatus; productFiles:string[]; core:Array<{ name:string; file:string; line:number; endLine:number }>; tables:string[]; deploy:boolean }> {
  const files = await trackedCode(input.projectCwd);
  const tests:string[] = [];
  let anchors:Anchor[] = [];
  for (const file of files) {
    const info = await stat(join(input.projectCwd, file)).catch(() => null);
    if (!info?.isFile() || info.size > 400_000) continue;
    const text = await readFile(join(input.projectCwd, file), "utf8").catch(() => "");
    if (TEST_PATH.test(file)) { for (const match of text.matchAll(/\b(?:it|test)\(\s*["'`](.+?)["'`]/g)) tests.push(`${file}: ${match[1]}`); continue; }
    anchors.push(...scanDeclarations(file, text));
  }
  anchors = anchors.sort((a, b) => Number(b.exported) - Number(a.exported) || Number(a.kind === "type") - Number(b.kind === "type")).slice(0, MAX_ANCHORS);
  const key = await jevApiKey();
  let answered = 0;
  if (key) {
    const questions = ANCHOR_QUESTIONS(input.pages);
    await pool(anchors.filter((anchor) => anchor.kind !== "type"), async (anchor) => {
      const answers = await jevAsk(key, { file:anchor.file, symbol:anchor.name, kind:anchor.kind, code:anchor.snippet }, questions);
      if (!answers) return;
      answered++;
      anchor.businessRule = answers.business_rule?.noul;
      anchor.userFacing = answers.user_facing?.noul;
      anchor.projectSpecific = answers.project_specific?.noul;
      anchor.importance = answers.importance?.score;
      if (answers.page?.choice && answers.page.choice !== "none") anchor.page = answers.page.choice;
    });
  }
  const asked = key ? anchors.filter((anchor) => anchor.kind !== "type").length : 1;
  const gitDir = (await run("git", ["-C", input.projectCwd, "rev-parse", "--git-dir"])).stdout.trim();
  const briefPath = join(isAbsolute(gitDir) ? gitDir : join(input.projectCwd, gitDir), "lane-pilot", "docs-anchors.md");
  await mkdir(dirname(briefPath), { recursive:true });
  await writeFile(briefPath, renderAnchorBrief(anchors, tests, await dependencies(input.projectCwd), key ? status(asked, answered) : "disabled"));
  // Files with code Jev judged specific to this product; generic kits and helpers do not call for docs.
  const productFiles = [...new Set(anchors.filter((anchor) => anchor.kind !== "type" && (anchor.projectSpecific ?? 1) >= 0.5).map((anchor) => anchor.file))].sort();
  // Core product behaviour the docs must cover: Jev's top importance on product code.
  const core = anchors.filter((anchor) => anchor.kind !== "type" && anchor.kind !== "table" && (anchor.projectSpecific ?? 0) >= 0.5 && (anchor.importance ?? 0) >= 1.5)
    .map(({ name, file, line, endLine }) => ({ name, file, line, endLine }));
  const tables = [...new Set(anchors.filter((anchor) => anchor.kind === "table").map((anchor) => anchor.name))].sort();
  // A project with a build or install script needs a how-to page for building, installing and running it.
  const scripts = await readFile(join(input.projectCwd, "package.json"), "utf8").then((text) => (JSON.parse(text) as { scripts?:Record<string, string> }).scripts ?? {}).catch(() => ({} as Record<string, string>));
  const deploy = Boolean(scripts.build || scripts.install || scripts.start || scripts.deploy);
  return { briefPath, anchors:anchors.length, jev:key ? status(asked, answered) : "disabled", productFiles, core, tables, deploy };
}

const pct = (value:number | undefined) => value === undefined ? "?" : `${Math.round(value * 100)}%`;
const at = (anchor:Anchor) => `${anchor.file}:${anchor.line}${anchor.endLine > anchor.line ? `-${anchor.endLine}` : ""}`;

export function renderAnchorBrief(anchors:Anchor[], tests:string[], deps:string[], jev:JevStatus):string {
  const product = (anchor:Anchor) => (anchor.projectSpecific ?? 1) >= 0.5;
  const rules = anchors.filter((anchor) => product(anchor) && (anchor.businessRule ?? 0) >= MARK_THRESHOLD).sort((a, b) => (b.businessRule ?? 0) - (a.businessRule ?? 0));
  const entries = anchors.filter((anchor) => product(anchor) && (anchor.userFacing ?? 0) >= MARK_THRESHOLD);
  const byFile = new Map<string, Anchor[]>();
  for (const anchor of anchors) byFile.set(anchor.file, [...(byFile.get(anchor.file) ?? []), anchor]);
  const lines = [
    "# Code anchors for the docs agent",
    "",
    `Built by Lane Pilot from the tracked code. Jev judgments: ${jev}. Cite these file:line anchors; treat each`,
    "business-rule and entry-point mark as a candidate to confirm in the code, not as a fact.",
    "",
    "## Business rule candidates",
    ...(rules.length ? rules.map((anchor) => `- \`${anchor.name}\` ${at(anchor)} (rule ${pct(anchor.businessRule)}${anchor.page ? `, page ${anchor.page}` : ""})`) : ["- none marked"]),
    "",
    "## Entry points",
    ...(entries.length ? entries.map((anchor) => `- \`${anchor.name}\` ${at(anchor)} (${anchor.kind}${anchor.page ? `, page ${anchor.page}` : ""})`) : ["- none marked"]),
    "",
    "## Declarations by file",
  ];
  for (const [file, list] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("", `### ${file}`);
    for (const anchor of list) {
      const marks = [anchor.exported ? "exported" : "internal", anchor.kind, product(anchor) ? "" : "generic",
        anchor.importance !== undefined ? `importance ${anchor.importance.toFixed(1)}` : "", anchor.page ? `page ${anchor.page}` : ""].filter(Boolean).join(", ");
      lines.push(`- \`${anchor.name}\` ${at(anchor)} (${marks})`);
    }
  }
  lines.push("", "## Dependencies", ...(deps.length ? deps.map((dep) => `- ${dep}`) : ["- none declared"]));
  lines.push("", "## Tests", ...(tests.length ? tests.slice(0, 200).map((test) => `- ${test}`) : ["- none found"]));
  return `${lines.join("\n")}\n`;
}

// ---- citation check -----------------------------------------------------------------------

const CITATION = /([A-Za-z0-9_@.\/-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;

export type ClaimRef = { file:string; start:number; end:number };

/** Claims in a page body - each sentence with all the file:line citations that back it together. */
export function pageClaims(body:string):Array<{ claim:string; refs:ClaimRef[] }> {
  const claims:Array<{ claim:string; refs:ClaimRef[] }> = [];
  for (const block of body.split(/\n(?=\s*[-*|]|\s*\n)|(?<=[.!?])\s+/)) {
    const text = block.replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("#")) continue;
    const refs = [...text.matchAll(CITATION)].map((match) => ({ file:match[1]!.replace(/^\.\//, ""), start:Number(match[2]), end:match[3] ? Number(match[3]) : Number(match[2]), at:match.index ?? 0 }));
    // A bare `190-193` after a file citation means more lines of that file.
    for (const bare of text.matchAll(/`(\d+)(?:-(\d+))?`/g)) {
      const owner = refs.filter((ref) => ref.at < (bare.index ?? 0)).at(-1);
      if (owner) refs.push({ file:owner.file, start:Number(bare[1]), end:bare[2] ? Number(bare[2]) : Number(bare[1]), at:bare.index ?? 0 });
    }
    if (refs.length) claims.push({ claim:text.slice(0, 600), refs:refs.sort((a, b) => a.at - b.at).map(({ file, start, end }) => ({ file, start, end })) });
  }
  return claims;
}

const refLabel = (ref:ClaimRef) => `${ref.file}:${ref.start}${ref.end !== ref.start ? `-${ref.end}` : ""}`;

/** Asks Jev whether the cited code backs each claim; an unsupported one becomes a lint finding. */
export async function verifyDocsCitations(input:{ projectCwd:string; pages:Array<{ path:string; content:string }>; related?:Array<{ path:string; content:string }> }):Promise<{ jev:JevStatus; checked:number;
  findings:Array<{ path:string; rule:string; detail:string }>; pageStats:Array<{ path:string; checked:number; supported:number }> }> {
  const key = await jevApiKey();
  if (!key) return { jev:"disabled", checked:0, findings:[], pageStats:[] };
  const checks = input.pages.flatMap((page) => {
    const body = page.content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    return pageClaims(body).map((claim) => ({ path:page.path, ...claim }));
  }).slice(0, MAX_CITATION_CHECKS);
  const files = new Map<string, string[] | null>();
  for (const ref of checks.flatMap((check) => check.refs)) if (!files.has(ref.file)) {
    const text = ref.file.split("/").includes("..") ? null : await readFile(join(input.projectCwd, ref.file), "utf8").catch(() => null);
    files.set(ref.file, text === null ? null : text.split("\n"));
  }
  const findings:Array<{ path:string; rule:string; detail:string }> = [];
  let answered = 0;
  const stats = new Map<string, { checked:number; supported:number }>();
  const criteria = { supported:"Together the cited code shows the behaviour, values or names the claim attributes to it.",
    partial:"The cited code is related and shows part of the claim; the rest is not in these lines.",
    unsupported:"The cited code does not show what the claim says, or contradicts it." };
  await pool(checks, async (check) => {
    // All citations of one claim are judged together: "validates (a) and stores (b)" needs both.
    const excerpts = check.refs.flatMap((ref) => {
      const lines = files.get(ref.file);
      if (!lines) return [];
      const from = Math.max(1, ref.start - 2), to = Math.min(lines.length, Math.max(ref.end, ref.start) + 2, from + 80);
      return [{ cited:refLabel(ref), from, to, code:lines.slice(from - 1, to).join("\n") }];
    });
    if (!excerpts.length) return;
    const answers = await jevAsk(key, { excerpts },
      { support:{ type:"choice", instructions:{ claim:check.claim, question:"Does the cited code in `excerpts` show what `claim` says it shows?" }, criteria } });
    if (!answers) return;
    answered++;
    const stat = stats.get(check.path) ?? { checked:0, supported:0 };
    stat.checked++;
    if (answers.support?.choice === "supported") stat.supported++;
    stats.set(check.path, stat);
    const unsupported = answers.support?.probabilities?.unsupported ?? 0;
    if (answers.support?.choice === "unsupported" && unsupported >= 0.6) {
      findings.push({ path:check.path, rule:"evidence-check",
        detail:`${check.refs.map(refLabel).join(", ")} do not back "${check.claim.slice(0, 160)}" (Jev ${Math.round(unsupported * 100)}%)` });
    }
  });
  const contradictions = await findContradictions(key, [...input.pages, ...(input.related ?? [])], new Set(input.pages.map((page) => page.path)));
  findings.push(...contradictions.findings);
  return { jev:status(checks.length + contradictions.asked, answered + contradictions.answered), checked:checks.length, findings,
    pageStats:[...stats].map(([path, stat]) => ({ path, ...stat })) };
}

const MAX_CONTRADICTION_PAIRS = 150;

/**
 * Two pages that cite the same lines describe the same code; Jev checks each such pair of claims
 * for a contradiction. Pairs involve at least one page written now; the rest of the docs are context.
 */
async function findContradictions(key:string, pages:Array<{ path:string; content:string }>, written:Set<string>):Promise<{ asked:number; answered:number; findings:Array<{ path:string; rule:string; detail:string }> }> {
  const claims = pages.flatMap((page) => pageClaims(page.content.replace(/^---\n[\s\S]*?\n---\n?/, "")).map((claim) => ({ path:page.path, ...claim })));
  const overlaps = (a:ClaimRef, b:ClaimRef) => a.file === b.file && a.start <= b.end && b.start <= a.end;
  const pairs:Array<[typeof claims[number], typeof claims[number]]> = [];
  for (let i = 0; i < claims.length && pairs.length < MAX_CONTRADICTION_PAIRS; i++) for (let j = i + 1; j < claims.length && pairs.length < MAX_CONTRADICTION_PAIRS; j++) {
    const a = claims[i]!, b = claims[j]!;
    if (a.path === b.path || (!written.has(a.path) && !written.has(b.path)) || a.claim === b.claim) continue;
    if (a.refs.some((ref) => b.refs.some((other) => overlaps(ref, other)))) pairs.push([a, b]);
  }
  const findings:Array<{ path:string; rule:string; detail:string }> = [];
  let answered = 0;
  await pool(pairs, async ([a, b]) => {
    const answers = await jevAsk(key, { first:{ page:a.path, statement:a.claim }, second:{ page:b.path, statement:b.claim } }, { relation:{ type:"choice",
      instructions:"Both statements describe the same lines of code. Can both be true at the same time?",
      criteria:{ consistent:"Both can be true: they agree, or describe different aspects without conflict.",
        contradict:"They state different values, behaviour or names for the same thing, so one of them must be wrong." } } });
    if (!answers) return;
    answered++;
    const p = answers.relation?.probabilities?.contradict ?? 0;
    if (answers.relation?.choice === "contradict" && p >= 0.6) {
      const target = written.has(a.path) ? a : b, other = target === a ? b : a;
      findings.push({ path:target.path, rule:"contradiction",
        detail:`"${target.claim.slice(0, 140)}" contradicts ${other.path}: "${other.claim.slice(0, 140)}" (Jev ${Math.round(p * 100)}%)` });
    }
  });
  return { asked:pairs.length, answered, findings };
}

// ---- staleness ----------------------------------------------------------------------------

async function diffSince(projectCwd:string, base:string, files:string[]):Promise<Map<string, string>> {
  const git = (...args:string[]) => run("git", ["-c", "core.quotePath=false", "-C", projectCwd, ...args], { maxBuffer:32 << 20 });
  const diffs = new Map<string, string>();
  for (const file of files) {
    const text = (await git("diff", base, "--", file).catch(() => ({ stdout:"" }))).stdout;
    if (text) diffs.set(file, text.split("\n").slice(0, 300).join("\n"));
  }
  return diffs;
}

/**
 * Pages whose sections describe code the diff actually changed in behaviour, as Jev judges it;
 * draft pages always. Without Jev the caller falls back to the sources intersection.
 */
export async function docsStaleness(input:{ projectCwd:string; base:string; changed:string[]; pages:Array<{ path:string; content:string }> }):Promise<{ jev:JevStatus; refresh:string[]; reasons:Array<{ path:string; section:string; p:number }> }> {
  const key = await jevApiKey();
  if (!key) return { jev:"disabled", refresh:[], reasons:[] };
  const changed = new Set(input.changed);
  // A page with no citations at all (the people's README) is judged whole against the changed code.
  const uncited = input.pages.filter((page) => ![...page.content.matchAll(CITATION)].length && input.changed.length)
    .map((page) => ({ path:page.path, heading:"(whole page)", text:page.content, files:input.changed.slice(0, 8) }));
  const sections = [...uncited, ...input.pages.filter((page) => [...page.content.matchAll(CITATION)].length).flatMap((page) => {
    const [head = "", ...rest] = page.content.split(/\n(?=## )/);
    return [head, ...rest].map((text) => ({ path:page.path, heading:(/^## (.+)$/m.exec(text)?.[1] ?? "(intro)").trim(), text,
      files:[...new Set([...text.matchAll(CITATION)].map((match) => match[1]!.replace(/^\.\//, "")))].filter((file) => changed.has(file)) }));
  })].filter((section) => section.files.length);
  const diffs = await diffSince(input.projectCwd, input.base, [...new Set(sections.flatMap((section) => section.files))]);
  const reasons:Array<{ path:string; section:string; p:number }> = [];
  let answered = 0;
  const asked = sections.filter((section) => section.files.some((file) => diffs.has(file)));
  await pool(asked, async (section) => {
    const answers = await jevAsk(key, { section:section.text.slice(0, 12_000), diff:section.files.map((file) => diffs.get(file) ?? "").join("\n") }, {
      stale:{ type:"noul", instructions:"Does `diff` change behaviour, names, commands, limits, data or flows that `section` describes, so that `section` is now wrong or incomplete?",
        criteria:{ true:"The section needs an update to stay accurate.", false:"The change is internal, cosmetic, or outside what the section describes." } } });
    if (!answers) return;
    answered++;
    const p = answers.stale?.noul ?? 0;
    if (p >= 0.5) reasons.push({ path:section.path, section:section.heading, p });
  });
  const drafts = input.pages.filter((page) => /^status:\s*draft\s*$/m.test(page.content.split("\n---")[0] ?? "")).map((page) => page.path);
  return { jev:status(asked.length, answered), refresh:[...new Set([...reasons.map((reason) => reason.path), ...drafts])].sort(), reasons };
}
