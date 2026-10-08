import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";
import { promisify } from "node:util";
import { CODE_FILE, TEST_PATH, jevApiKey, jevAsk, jevPool, jevStatus, scanDeclarations, type JevStatus } from "./docs-jev";

/**
 * End-to-end flows for the root docs, found before the docs agent writes: code builds the import graph,
 * finds entry points (HTTP routes, bot commands, jobs, pages) and the business modules of the shared
 * packages, and traces each entry to the modules it reaches. Jev only judges the candidates: which
 * modules are business processes, how central each is, and which entries really drive a process.
 */

const run = promisify(execFile);
const SKIP = /(^|\/)(docs|dist|build|node_modules|vendor|\.nuxt|\.output|__tests__|test-utils|testing)\//;
/** Module folder names that hold plumbing, not a business process. */
const GENERIC = new Set(["shared", "common", "utils", "util", "lib", "libs", "helpers", "types", "config", "constants", "core", "internal",
  "testing", "test", "tests", "mocks", "fixtures", "errors", "context", "index", "ports", "adapters", "infrastructure", "di", "composition"]);
const ENTRY_DIR = /(^|\/)(handlers|jobs|workers|processors|commands|pages|routes|controllers|cron)\//;
const MAX_FLOWS = 20;
const MAX_ENTRIES_JUDGED = 25;
const MAX_DEPTH = 8;

export type RouteRef = { method:string; path:string; file:string; line:number };
export type FlowWorkspace = { path:string; name:string };

/** HTTP routes (Express/Fastify style calls, Nuxt/Nitro server files) and bot commands declared in one file. */
export function extractRoutes(file:string, text:string):RouteRef[] {
  const routes:RouteRef[] = [];
  // A file-based page (Nuxt, Next pages/) is a screen with a route.
  const page = /(?:^|\/)pages\/(.+)\.vue$/.exec(file);
  if (page && !page[1]!.includes("__tests__")) {
    const path = `/${page[1]!}`.replace(/\/index$/, "").replace(/\[\.\.\.(\w+)\]/g, "*$1").replace(/\[(\w+)\]/g, ":$1");
    routes.push({ method:"PAGE", path:path || "/", file, line:1 });
  }
  const nitro = /(?:^|\/)server\/(api|routes)\/(.+?)(?:\.(get|post|put|patch|delete))?\.(?:ts|js|mjs)$/.exec(file);
  if (nitro) {
    const path = `${nitro[1] === "api" ? "/api/" : "/"}${nitro[2]!}`.replace(/\/index$/, "").replace(/\[\.\.\.(\w+)\]/g, "*$1").replace(/\[(\w+)\]/g, ":$1");
    routes.push({ method:(nitro[3] ?? "ANY").toUpperCase(), path:path || "/", file, line:1 });
  }
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/\b(?:app|router|fastify|server|instance|api|r)\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`]*)['"`]/g)) {
      routes.push({ method:match[1]!.toUpperCase(), path:match[2]!, file, line:index + 1 });
    }
    for (const match of line.matchAll(/\.(command|hears|callbackQuery)\(\s*['"`]([^'"`]+)['"`]/g)) {
      routes.push({ method:match[1] === "command" ? "BOT /" : "BOT", path:match[2]!, file, line:index + 1 });
    }
  });
  return routes;
}

const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".vue", "/index.ts", "/index.js", "/index.mjs"];

/** The names an import statement brings in: `{ a, b as c }` gives a and b; a default or namespace import gives nothing. */
function importedNames(statement:string):string[] {
  const braces = /\{([^}]*)\}/.exec(statement)?.[1];
  if (!braces) return [];
  return braces.split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim()).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

/**
 * Resolves import specifiers to tracked files - relative paths, ~/ and @/ aliases, workspace packages with
 * subpaths - and keeps, for each edge, the names imported through it.
 */
export function importGraph(files:Map<string, string>, workspaces:FlowWorkspace[]):Map<string, Map<string, string[]>> {
  const tracked = new Set(files.keys());
  const byName = [...workspaces].sort((a, b) => b.name.length - a.name.length);
  const workspaceOf = (file:string) => workspaces.filter((ws) => file.startsWith(`${ws.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  const tryPaths = (bases:string[]) => {
    for (const base of bases) for (const ext of EXTENSIONS) {
      const candidate = posix.normalize(`${base.replace(/\.(m?js)$/, "")}${ext}`);
      if (tracked.has(candidate)) return candidate;
      if (tracked.has(posix.normalize(`${base}${ext}`))) return posix.normalize(`${base}${ext}`);
    }
    return null;
  };
  const graph = new Map<string, Map<string, string[]>>();
  for (const [file, text] of files) {
    const edges = new Map<string, string[]>();
    for (const match of text.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!spec) continue;
      let target:string | null = null;
      if (spec.startsWith(".")) target = tryPaths([posix.join(posix.dirname(file), spec)]);
      else if (/^[~@]\//.test(spec)) {
        const root = workspaceOf(file)?.path ?? "";
        const rest = spec.slice(2);
        target = tryPaths([posix.join(root, rest), posix.join(root, "app", rest), posix.join(root, "src", rest)].map((path) => path.replace(/^\//, "")));
      } else {
        const ws = byName.find((item) => spec === item.name || spec.startsWith(`${item.name}/`));
        if (ws) {
          const sub = spec.slice(ws.name.length + 1);
          target = sub ? tryPaths([posix.join(ws.path, "src", sub), posix.join(ws.path, sub)]) : tryPaths([posix.join(ws.path, "src/index"), posix.join(ws.path, "index")]);
        }
      }
      if (target && target !== file) edges.set(target, [...new Set([...(edges.get(target) ?? []), ...importedNames(match[0])])]);
    }
    graph.set(file, edges);
  }
  return graph;
}

type Candidate = { name:string; modules:string[]; files:string[]; entries:Map<string, string[]> };

/**
 * Business modules: the top folders under src/ of the shared (non-app) workspaces, merged by name across
 * packages (domain/generation and application/generation are one process); a single repository uses src/*.
 */
function moduleRoots(files:string[], workspaces:Array<FlowWorkspace & { app:boolean }>):Map<string, string[]> {
  const shared = workspaces.filter((ws) => !ws.app);
  const bases = shared.length ? shared.map((ws) => `${ws.path}/src`) : workspaces.length ? [] : ["src"];
  const roots = new Map<string, string[]>();
  for (const base of bases) {
    const counts = new Map<string, number>();
    for (const file of files) {
      if (!file.startsWith(`${base}/`)) continue;
      const name = file.slice(base.length + 1).split("/")[0]!;
      if (!name.includes(".")) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    let folders = 0;
    for (const [name, count] of counts) {
      if (count < 2 || GENERIC.has(name.toLowerCase())) continue;
      folders++;
      roots.set(name, [...(roots.get(name) ?? []), `${base}/${name}`]);
    }
    // A small package that keeps its logic flat in src/ is one module, named after the package.
    const flat = files.filter((file) => file.startsWith(`${base}/`) && !file.slice(base.length + 1).includes("/")).length;
    if (!folders && flat >= 3) {
      const name = posix.basename(posix.dirname(base));
      if (!GENERIC.has(name.toLowerCase())) roots.set(name, [...(roots.get(name) ?? []), base]);
    }
  }
  return roots;
}

function head(text:string, lines:number):string {
  return text.split("\n").slice(0, lines).join("\n").slice(0, 4000);
}

export async function buildDocsFlows(input:{ projectCwd:string; workspaces:FlowWorkspace[]; keep?:string[] }):Promise<{ briefPath:string; jev:JevStatus;
  flows:Array<{ name:string; slug:string; entries:number; modules:string[]; briefPath:string; files:string[];
    calls:Array<{ name:string; file:string; line:number; endLine:number }> }>; routes:number }> {
  const listed = (await run("git", ["-c", "core.quotePath=false", "-C", input.projectCwd, "ls-files"], { maxBuffer:64 << 20 })).stdout.split("\n");
  const paths = listed.filter((path) => CODE_FILE.test(path) && !path.endsWith(".prisma") && !TEST_PATH.test(path) && !SKIP.test(path) && !/(^|\/)\.[^/]+\//.test(path));
  const files = new Map<string, string>();
  for (const path of paths) {
    const text = await readFile(join(input.projectCwd, path), "utf8").catch(() => null);
    if (text !== null && text.length < 400_000) files.set(path, text);
  }
  const workspaces = await Promise.all(input.workspaces.map(async (ws) => {
    const pkg = await readFile(join(input.projectCwd, ws.path, "package.json"), "utf8").then((text) => JSON.parse(text) as { scripts?:Record<string, string> }, () => ({} as { scripts?:Record<string, string> }));
    // A library often has a dev (watch build) script too, so only apps/ or a start script makes an app.
    return { ...ws, app:ws.path.startsWith("apps/") || Boolean(pkg.scripts?.start) };
  }));
  const graph = importGraph(files, workspaces);
  const routes = [...files].flatMap(([file, text]) => extractRoutes(file, text));
  const routeFiles = new Map<string, RouteRef[]>();
  for (const route of routes) routeFiles.set(route.file, [...(routeFiles.get(route.file) ?? []), route]);
  // A UI or bot calls the API over HTTP, not through imports: a path literal that matches a route links the caller to the route file.
  const httpRoutes = routes.filter((route) => !route.method.startsWith("BOT") && route.path.split("/").filter(Boolean).length >= 2)
    .map((route) => ({ file:route.file, label:`${route.method} ${route.path}`, parts:route.path.split("/").filter(Boolean) }));
  const matchesRoute = (literal:string[], parts:string[]) => literal.length >= parts.length
    && parts.every((part, index) => { const seg = literal[literal.length - parts.length + index]!; return part.startsWith(":") || part.startsWith("*") || seg === ":p" || seg === part; });
  for (const [file, text] of files) {
    const edges = graph.get(file)!;
    for (const match of text.matchAll(/['"`](\/(?:api|v\d+)\/[^'"`\s?#]*)['"`?]/g)) {
      const literal = match[1]!.replace(/\$\{[^}]*\}/g, ":p").split("/").filter(Boolean);
      for (const route of httpRoutes) if (route.file !== file && matchesRoute(literal, route.parts) && !edges.has(route.file)) edges.set(route.file, [`HTTP ${route.label}`]);
    }
  }
  const appPaths = workspaces.filter((ws) => ws.app).map((ws) => `${ws.path}/`);
  const inApp = (file:string) => !workspaces.length || appPaths.some((prefix) => file.startsWith(prefix));
  const entries = [...files.keys()].filter((file) => inApp(file) && (routeFiles.has(file) || ENTRY_DIR.test(file)));

  // Trace every entry through the import graph, remembering the first chain that reaches each module.
  const roots = moduleRoots([...files.keys()], workspaces);
  const moduleOf = (file:string) => { for (const [name, dirs] of roots) if (dirs.some((dir) => file.startsWith(`${dir}/`))) return name; return null; };
  const candidates = new Map<string, Candidate>();
  for (const entry of entries) {
    const parent = new Map<string, string | null>([[entry, null]]);
    let frontier = [entry];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const next:string[] = [];
      for (const file of frontier) for (const target of (graph.get(file) ?? new Map()).keys()) if (!parent.has(target)) { parent.set(target, file); next.push(target); }
      frontier = next;
    }
    for (const file of parent.keys()) {
      const name = moduleOf(file);
      if (!name) continue;
      const candidate = candidates.get(name) ?? { name, modules:roots.get(name)!, files:[...files.keys()].filter((path) => roots.get(name)!.some((dir) => path.startsWith(`${dir}/`))), entries:new Map() };
      if (!candidate.entries.has(entry)) {
        const chain:string[] = [];
        for (let at:string | null = file; at; at = parent.get(at) ?? null) chain.unshift(at);
        candidate.entries.set(entry, chain);
      }
      candidates.set(name, candidate);
    }
  }
  // A module nearly every entry reaches is plumbing, whatever its name.
  const common = [...candidates.values()].filter((candidate) => candidate.entries.size > 0 && candidate.entries.size <= Math.max(3, entries.length * 0.6));

  const key = await jevApiKey();
  let asked = 0, answered = 0;
  const judged = await jevPool(common, async (candidate) => {
    if (!key) return { candidate, business:1, importance:candidate.entries.size };
    asked++;
    const sample = candidate.files.slice(0, 3).map((file) => ({ file, code:head(files.get(file) ?? "", 60) }));
    const answers = await jevAsk(key, { process:candidate.name, modules:candidate.modules, files:candidate.files.slice(0, 40), sample }, {
      business:{ type:"noul", instructions:"Is `process` a business process that users or operators of the product go through - such as paying, generating content, signing in or moderating - rather than shared plumbing, configuration or a technical utility?" },
      importance:{ type:"score", instructions:"How central is `process` to what the product does for its users?", criteria:["A minor or supporting process", "A regular product process", "A core process the product exists for"] },
    });
    if (answers) answered++;
    return { candidate, business:answers?.business?.noul ?? 0.5, importance:answers?.importance?.score ?? 1 };
  });
  const slug = (name:string) => name.replace(/([a-z])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase().replace(/^-|-$/g, "");
  // A flow that already has a page stays a flow, so its page keeps an owner that refreshes it; new ones fill the rest by importance.
  const kept = new Set(input.keep ?? []);
  const isKept = (item:typeof judged[number]) => kept.has(slug(item.candidate.name));
  const ranked = judged.filter((item) => isKept(item) || item.business >= 0.5)
    .sort((a, b) => Number(isKept(b)) - Number(isKept(a)) || b.importance - a.importance || b.candidate.entries.size - a.candidate.entries.size || a.candidate.name.localeCompare(b.candidate.name));
  const chosen = ranked.slice(0, Math.max(MAX_FLOWS, ranked.filter(isKept).length));

  const workspaceName = (file:string) => workspaces.filter((ws) => file.startsWith(`${ws.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]?.name ?? "(root)";
  // What an entry calls in the process: the names the last hop imports, found among the process's declarations.
  const declared = new Map<string, Array<{ name:string; file:string; line:number; endLine:number; kind:string }>>();
  const uses = (candidate:Candidate, chain:string[]) => {
    if (!declared.has(candidate.name)) declared.set(candidate.name, candidate.files.flatMap((file) => scanDeclarations(file, files.get(file) ?? "").filter((anchor) => anchor.exported)
      .map(({ name, file:at, line, endLine, kind }) => ({ name, file:at, line, endLine, kind }))));
    const hop = chain.length >= 2 ? graph.get(chain[chain.length - 2]!)?.get(chain[chain.length - 1]!) ?? [] : [];
    return hop.flatMap((name) => declared.get(candidate.name)!.filter((item) => item.name === name).slice(0, 1)).slice(0, 8);
  };
  const describe = (chain:string[]) => chain.map((file, index) => {
    const via = index ? graph.get(chain[index - 1]!)?.get(file)?.find((name) => name.startsWith("HTTP ")) : undefined;
    return via ? `(${via}) ${file}` : file;
  }).join(" -> ");

  // Jev keeps the entries that drive the process, not those that only import a helper from it; each app gets its turn.
  const flows = await Promise.all(chosen.map(async ({ candidate, importance }) => {
    const byApp = new Map<string, Array<[string, string[]]>>();
    for (const item of [...candidate.entries].sort((a, b) => a[1].length - b[1].length)) byApp.set(workspaceName(item[0]), [...(byApp.get(workspaceName(item[0])) ?? []), item]);
    const ranked:Array<[string, string[]]> = [];
    for (let round = 0; ranked.length < MAX_ENTRIES_JUDGED && [...byApp.values()].some((list) => list.length > round); round++) {
      for (const list of byApp.values()) if (list[round] && ranked.length < MAX_ENTRIES_JUDGED) ranked.push(list[round]!);
    }
    const kept = await jevPool(ranked, async ([entry, chain]) => {
      if (!key) return { entry, chain, drives:1 };
      asked++;
      const answers = await jevAsk(key, { process:candidate.name, processModules:candidate.modules, entry, routes:(routeFiles.get(entry) ?? []).map((route) => `${route.method} ${route.path}`),
        code:head(files.get(entry) ?? "", 50), importChain:describe(chain), calls:uses(candidate, chain).map((item) => item.name) }, {
        drives:{ type:"noul", instructions:"Does `entry` start or drive the `process` for a user or operator (it handles a request, command, job or page that runs this process), rather than only importing a shared helper or type from it?" },
      });
      if (answers) answered++;
      return { entry, chain, drives:answers?.drives?.noul ?? 0.5 };
    });
    return { candidate, importance, entries:kept.filter((item) => item.drives >= 0.5) };
  }));
  const documented = flows.filter((flow) => flow.entries.length);

  const header = [`Built by Lane Pilot from the import graph; Jev judgments: ${key ? jevStatus(asked, answered) : "disabled"}.`,
    "The flow is a business process found in the shared modules, with the entry points in the apps that drive it, one import chain",
    "from each entry into the process and what the entry calls there. Confirm every step in the code before you describe it; an entry listed here is a candidate, not a fact.", ""];
  const sections = documented.map((flow) => {
    const lines = [`## ${flow.candidate.name} -> docs/flows/${slug(flow.candidate.name)}.md`, "",
      `Modules: ${flow.candidate.modules.map((dir) => `${dir}/`).join(", ")} (${flow.candidate.files.length} files). Importance ${flow.importance.toFixed(1)}.`, "", "Entry points:"];
    const byWorkspace = new Map<string, typeof flow.entries>();
    for (const item of flow.entries) byWorkspace.set(workspaceName(item.entry), [...(byWorkspace.get(workspaceName(item.entry)) ?? []), item]);
    const calls = new Map<string, { name:string; file:string; line:number; endLine:number }>();
    for (const [name, items] of byWorkspace) {
      lines.push(`- ${name}:`);
      for (const item of items) {
        const found = routeFiles.get(item.entry) ?? [];
        lines.push(`  - ${item.entry}${found.length ? ` - ${found.slice(0, 6).map((route) => `${route.method} ${route.path} (line ${route.line})`).join(", ")}${found.length > 6 ? ", …" : ""}` : ""}`);
        lines.push(`    chain: ${describe(item.chain)}`);
        const called = uses(flow.candidate, item.chain);
        if (called.length) lines.push(`    calls: ${called.map((use) => `${use.name} (${use.file}:${use.line})`).join(", ")}`);
        // Behaviour the page must explain: functions and classes, with their real bounds; types and constants have no steps.
        for (const use of called) if (use.kind === "function" || use.kind === "class") calls.set(`${use.file}:${use.name}`, { name:use.name, file:use.file, line:use.line, endLine:use.endLine });
      }
    }
    lines.push("", "Process files:", ...flow.candidate.files.slice(0, 40).map((file) => `- ${file}`), ...(flow.candidate.files.length > 40 ? [`- …and ${flow.candidate.files.length - 40} more`] : []), "");
    // The code the flow page describes: its modules, its entries and every file on the chains between them.
    const files = [...new Set([...flow.candidate.files, ...flow.entries.flatMap((item) => item.chain)])].sort();
    return { flow, lines, calls:[...calls.values()], files };
  });
  const gitDir = (await run("git", ["-C", input.projectCwd, "rev-parse", "--git-dir"])).stdout.trim();
  const dir = join(isAbsolute(gitDir) ? gitDir : join(input.projectCwd, gitDir), "lane-pilot");
  await mkdir(dir, { recursive:true });
  const briefPath = join(dir, "docs-flows.md");
  await writeFile(briefPath, `${["# Flows", "", ...header, ...sections.flatMap((section) => section.lines)].join("\n")}\n`);
  // Each flow is written by its own agent, which reads only its own skeleton.
  const flowsOut = [];
  for (const section of sections) {
    const name = slug(section.flow.candidate.name);
    const path = join(dir, `docs-flow-${name}.md`);
    await writeFile(path, `${[`# Flow: ${section.flow.candidate.name}`, "", ...header, ...section.lines].join("\n")}\n`);
    flowsOut.push({ name:section.flow.candidate.name, slug:name, entries:section.flow.entries.length, modules:section.flow.candidate.modules,
      briefPath:path, files:section.files.slice(0, 2000), calls:section.calls.slice(0, 200) });
  }
  return { briefPath, jev:key ? jevStatus(asked, answered) : "disabled", routes:routes.length, flows:flowsOut };
}
