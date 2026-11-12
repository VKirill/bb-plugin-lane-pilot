import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { extractRoutes, type RouteRef } from "./docs-routes";
import { parsePrisma, prismaAccess, renderDataMap } from "./docs-data";
import { CITATION_SOURCE, expandCitationLists } from "./docs-lint";
import { promisify } from "node:util";
import { parseJsonOr, readTextOrNull, statOrNull } from "@lane-pilot/kit";

/**
 * The documentation pipeline's code map: declarations, routes, the data map and the brief the docs agent starts from. Everything here is
 * code (regexes and arithmetic); no model marks a declaration. A declaration the scan finds is a candidate the agent confirms in the code.
 */

const run = promisify(execFile);
export const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|vue|prisma)$/;
const SKIP_PATH = /(^|\/)(docs|dist|build|node_modules|vendor|\.nuxt|\.output)\/|^(\.agents|\.bb|\.claude)\//;
export const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/;
const MAX_ANCHORS = 300;
const SNIPPET_LINES = 60;

// ---- anchors ------------------------------------------------------------------------------

export type Anchor = {
  name:string; kind:"function" | "class" | "type" | "const" | "table" | "component"; exported:boolean;
  file:string; line:number; endLine:number; snippet:string;
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

/**
 * Declarations found line by line: a start is a top-level line matching a declaration, the body runs to the next one.
 * A Vue single-file component is itself an anchor; Prisma models are tables and its enums types.
 */
export function scanDeclarations(file:string, text:string):Anchor[] {
  const lines = text.split("\n");
  const starts:Array<{ line:number; name:string; kind:Anchor["kind"]; exported:boolean }> = [];
  if (file.endsWith(".vue")) starts.push({ line:1, name:basename(file, ".vue"), kind:"component", exported:true });
  lines.forEach((line, index) => {
    if (file.endsWith(".prisma")) {
      const model = /^(model|enum)\s+([A-Za-z_]\w*)\s*\{/.exec(line);
      if (model?.[2]) starts.push({ line:index + 1, name:model[2], kind:model[1] === "model" ? "table" : "type", exported:true });
      return;
    }
    for (const decl of DECLARATIONS) {
      const match = decl.re.exec(line);
      if (match?.[1]) { starts.push({ line:index + 1, name:match[1], kind:decl.kind, exported:decl.exported }); break; }
    }
    const table = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z_]\w*)/i.exec(line);
    if (table?.[1]) starts.push({ line:index + 1, name:table[1], kind:"table", exported:true });
  });
  // A file ending in a newline splits into one empty element past its last line; the citation check counts the
  // file's real lines, so an anchor of the last declaration would end one line past the end of the file.
  const lineCount = lines.length - (text.endsWith("\n") ? 1 : 0);
  return starts.map((start, index) => {
    const nextStart = starts.slice(index + 1).find((other) => (other.kind !== "table" || file.endsWith(".prisma")) && other.kind !== "component" && other.line > start.line)?.line ?? lineCount + 1;
    const endLine = Math.min(nextStart - 1, start.line + SNIPPET_LINES - 1, lineCount);
    return { name:start.name, kind:start.kind, exported:start.exported, file, line:start.line, endLine,
      snippet:lines.slice(start.line - 1, endLine).join("\n").slice(0, 4000) };
  });
}

/** Tracked code under `prefix`, without the folders in `exclude` (workspaces that keep their own docs). */
async function trackedCode(projectCwd:string, prefix = "", exclude:string[] = []):Promise<string[]> {
  const listed = (await run("git", ["-c", "core.quotePath=false", "-C", projectCwd, "ls-files"], { maxBuffer:64 << 20 })).stdout.split("\n");
  return listed.filter((path) => CODE_FILE.test(path) && !SKIP_PATH.test(path) && path.startsWith(prefix)
    && !exclude.some((dir) => path.startsWith(`${dir}/`)));
}

/**
 * At most `max` anchors taken round-robin across files, best first within each file, so a large codebase
 * is mapped across all its files rather than the first few hundred declarations; tables always stay.
 */
export function spreadAnchors(all:Anchor[], max:number):Anchor[] {
  const rank = (anchor:Anchor) => Number(!anchor.exported) * 2 + Number(anchor.kind === "type");
  const picked = all.filter((anchor) => anchor.kind === "table").slice(0, max);
  const byFile = new Map<string, Anchor[]>();
  for (const anchor of all) if (anchor.kind !== "table") byFile.set(anchor.file, [...(byFile.get(anchor.file) ?? []), anchor]);
  const lists = [...byFile.values()].map((list) => [...list].sort((a, b) => rank(a) - rank(b)));
  for (let round = 0; picked.length < max && lists.some((list) => list.length > round); round++) {
    for (const list of lists) if (list[round] && picked.length < max) picked.push(list[round]!);
  }
  return picked;
}

async function dependencies(projectCwd:string, prefix = ""):Promise<string[]> {
  const pkg = parseJsonOr(await readTextOrNull(join(projectCwd, prefix, "package.json")) ?? "", null) as Record<string, Record<string, string>> | null;
  if (!pkg) return [];
  return [...Object.entries(pkg.dependencies ?? {}).map(([name, version]) => `${name}@${version}`),
    ...Object.entries(pkg.devDependencies ?? {}).map(([name, version]) => `${name}@${version} (dev)`)];
}

/**
 * Maps the project's code into anchors and writes the brief the docs agent starts from under .git/, outside anything git tracks.
 */
export type DocsWorkspaceRef = { path:string; name:string; docsDir:string | null };

/**
 * One docs folder's code: `prefix` narrows it to a monorepo workspace, `exclude` takes the workspaces with their
 * own docs out of the root's share, and `workspaces` gives the root brief its map of the monorepo.
 */
export async function buildDocsAnchors(input:{ projectCwd:string; pages:Array<{ path:string; title:string }>; prefix?:string; exclude?:string[]; workspaces?:DocsWorkspaceRef[] }):Promise<{ briefPath:string; anchors:number; productFiles:string[]; core:Array<{ name:string; file:string; line:number; endLine:number }>; tables:string[]; deploy:boolean }> {
  const prefix = input.prefix ?? "";
  const files = await trackedCode(input.projectCwd, prefix, input.exclude);
  const tests:string[] = [];
  const routes:RouteRef[] = [];
  let anchors:Anchor[] = [];
  for (const file of files) {
    const info = await statOrNull(join(input.projectCwd, file));
    if (!info?.isFile() || info.size > 400_000) continue;
    const text = await readTextOrNull(join(input.projectCwd, file)) ?? "";
    if (TEST_PATH.test(file)) { for (const match of text.matchAll(/\b(?:it|test)\(\s*["'`](.+?)["'`]/g)) tests.push(`${file}: ${match[1]}`); continue; }
    anchors.push(...scanDeclarations(file, text));
    routes.push(...extractRoutes(file, text));
  }
  anchors = spreadAnchors(anchors, MAX_ANCHORS);
  const gitDir = (await run("git", ["-C", input.projectCwd, "rev-parse", "--git-dir"])).stdout.trim();
  const briefName = prefix ? `docs-anchors-${prefix.replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "")}.md` : "docs-anchors.md";
  const briefPath = join(isAbsolute(gitDir) ? gitDir : join(input.projectCwd, gitDir), "lane-pilot", briefName);
  await mkdir(dirname(briefPath), { recursive:true });
  const workspaceMap = input.workspaces?.length ? await renderWorkspaceMap(input.projectCwd, input.workspaces) : [];
  // A folder that defines a Prisma schema gets the data map: models, enums, and every write and read across the repository.
  const schemaFiles = files.filter((file) => file.endsWith(".prisma"));
  let dataMap:string[] = [];
  if (schemaFiles.length) {
    const parsed = await Promise.all(schemaFiles.map(async (file) => parsePrisma(file, await readTextOrNull(join(input.projectCwd, file)) ?? "")));
    const models = parsed.flatMap((item) => item.models), enums = parsed.flatMap((item) => item.enums);
    const code = new Map<string, string>();
    for (const file of await trackedCode(input.projectCwd)) {
      if (file.endsWith(".prisma") || TEST_PATH.test(file)) continue;
      const text = await readTextOrNull(join(input.projectCwd, file)) ?? "";
      if (text.length < 400_000) code.set(file, text);
    }
    const tables = new Map(models.flatMap((model) => model.table ? [[model.table.toLowerCase(), model.name] as [string, string]] : []));
    dataMap = renderDataMap(models, enums, prismaAccess(code, models.map((model) => model.name), tables));
  }
  const routeList = routes.length ? ["", "## Routes and bot commands", "", "Every one belongs on a page (api.md or the feature page): method, path, who calls it, what it does, auth.", "",
    ...routes.slice(0, 600).map((route) => `- ${route.method} ${route.path} - ${route.file}:${route.line}`), ...(routes.length > 600 ? [`- …and ${routes.length - 600} more`] : []), ""] : [];
  await writeFile(briefPath, renderAnchorBrief(anchors, tests, await dependencies(input.projectCwd, prefix)) + routeList.join("\n") + workspaceMap.join("\n") + dataMap.join("\n"));
  // Files with code that calls for docs: every file that declares something.
  const productFiles = [...new Set(anchors.filter((anchor) => anchor.kind !== "type").map((anchor) => anchor.file))].sort();
  // Core product behaviour the docs must cover: every file that declares routes.
  const routeFiles = new Map<string, RouteRef[]>();
  for (const route of routes) routeFiles.set(route.file, [...(routeFiles.get(route.file) ?? []), route]);
  const core = [
    ...[...routeFiles].map(([file, list]) => ({ name:`routes ${list.slice(0, 3).map((route) => `${route.method} ${route.path}`).join(", ")}${list.length > 3 ? ", …" : ""}`, file,
      line:Math.min(...list.map((route) => route.line)), endLine:Math.max(...list.map((route) => route.line)) })),
  ];
  const tables = [...new Set(anchors.filter((anchor) => anchor.kind === "table").map((anchor) => anchor.name))].sort();
  // A project with a build or install script needs a how-to page for building, installing and running it.
  // A monorepo is built and deployed from its root, so only the root docs get the page.
  const scripts = prefix ? {} : (parseJsonOr<{ scripts?: Record<string, string> }>(await readTextOrNull(join(input.projectCwd, "package.json")) ?? "", {})).scripts ?? {};
  const deploy = Boolean(scripts.build || scripts.install || scripts.start || scripts.deploy);
  return { briefPath, anchors:anchors.length, productFiles, core, tables, deploy };
}

/** The monorepo map for the root docs: each workspace, where its docs live and which workspaces it uses. */
async function renderWorkspaceMap(projectCwd:string, workspaces:DocsWorkspaceRef[]):Promise<string[]> {
  const names = new Set(workspaces.map((workspace) => workspace.name));
  const lines = ["", "## Workspaces", "", "Workspaces with a docs folder are documented there by their own pass; link to them. The others belong to the root docs.", ""];
  for (const workspace of workspaces) {
    const pkg = await readFile(join(projectCwd, workspace.path, "package.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => ({} as Record<string, unknown>));
    const uses = Object.keys({ ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) }).filter((name) => names.has(name));
    const description = typeof pkg.description === "string" && pkg.description ? ` - ${pkg.description}` : "";
    const scripts = Object.keys(pkg.scripts as object ?? {}).filter((name) => /^(build|dev|start|serve|preview|generate|deploy|migrate|worker)(:|$)/.test(name));
    lines.push(`- \`${workspace.name}\` ${workspace.path}${description}. Docs: ${workspace.docsDir ? `${workspace.docsDir}/` : "root docs"}.${uses.length ? ` Uses: ${uses.join(", ")}.` : ""}${scripts.length ? ` Scripts: ${scripts.join(", ")} (${workspace.path}/package.json).` : ""}`);
  }
  // How the system is built and run: compose services and the task pipeline, for deployment and architecture.
  for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const text = await readTextOrNull(join(projectCwd, name));
    if (text === null) continue;
    const services = /^services:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
    lines.push("", `## Services in ${name}`, "", ...[...services.matchAll(/^  ([A-Za-z0-9_.-]+):\s*$/gm)].map((match) => `- ${match[1]} - ${name}:${text.slice(0, text.indexOf(match[0])).split("\n").length}`));
  }
  const turbo = await readFile(join(projectCwd, "turbo.json"), "utf8").then((text) => JSON.parse(text) as { tasks?:object; pipeline?:object }, () => null);
  if (turbo) lines.push("", "## Turbo tasks (turbo.json)", "", ...Object.keys(turbo.tasks ?? turbo.pipeline ?? {}).map((task) => `- ${task}`));
  return [...lines, ""];
}

const at = (anchor:Anchor) => `${anchor.file}:${anchor.line}${anchor.endLine > anchor.line ? `-${anchor.endLine}` : ""}`;

export function renderAnchorBrief(anchors:Anchor[], tests:string[], deps:string[]):string {
  const byFile = new Map<string, Anchor[]>();
  for (const anchor of anchors) byFile.set(anchor.file, [...(byFile.get(anchor.file) ?? []), anchor]);
  const lines = [
    "# Code anchors for the docs agent",
    "",
    "Built by Lane Pilot from the tracked code: declarations found by a line scan, no model marks. Cite these file:line anchors; each one is a",
    "candidate to confirm in the code, not a fact.",
    "",
    "## Declarations by file",
  ];
  for (const [file, list] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("", `### ${file}`);
    for (const anchor of list) {
      const marks = [anchor.exported ? "exported" : "internal", anchor.kind].join(", ");
      lines.push(`- \`${anchor.name}\` ${at(anchor)} (${marks})`);
    }
  }
  lines.push("", "## Dependencies", ...(deps.length ? deps.map((dep) => `- ${dep}`) : ["- none declared"]));
  lines.push("", "## Tests", ...(tests.length ? tests.slice(0, 200).map((test) => `- ${test}`) : ["- none found"]));
  return `${lines.join("\n")}\n`;
}

// ---- claims -------------------------------------------------------------------------------

/** file:line or file:start-end; paths may hold Nuxt route brackets such as server/api/[slug].get.ts. */
const CITATION = new RegExp(CITATION_SOURCE, "g");

export type ClaimRef = { file:string; start:number; end:number };

/** Claims in a page body - each sentence with all the file:line citations that back it together. */
export function pageClaims(body:string):Array<{ claim:string; refs:ClaimRef[] }> {
  const claims:Array<{ claim:string; refs:ClaimRef[] }> = [];
  for (const block of expandCitationLists(body).split(/\n(?=\s*[-*|]|\s*\n)|(?<=[.!?])\s+/)) {
    const text = block.replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("#")) continue;
    const refs = [...text.matchAll(CITATION)].map((match) => ({ file:match[1]!.replace(/^\.\//, ""), start:Number(match[2]), end:match[3] ? Number(match[3]) : Number(match[2]), at:match.index ?? 0 }));
    // A bare `190-193` after a file citation means more lines of that file.
    for (const bare of text.matchAll(/`(\d+)(?:-(\d+))?`/g)) {
      const owner = refs.filter((ref) => ref.at < (bare.index ?? 0)).at(-1);
      if (owner) refs.push({ file:owner.file, start:Number(bare[1]), end:bare[2] ? Number(bare[2]) : Number(bare[1]), at:bare.index ?? 0 });
    }
    // A fragment that is only citations (a table cell) states nothing to verify or compare.
    const words = text.replace(CITATION, " ").replace(/`\d+(?:-\d+)?`/g, " ").match(/[A-Za-z\u0400-\u04FF]{2,}/g) ?? [];
    if (refs.length && words.length >= 3) claims.push({ claim:text.slice(0, 600), refs:refs.sort((a, b) => a.at - b.at).map(({ file, start, end }) => ({ file, start, end })) });
  }
  return claims;
}
