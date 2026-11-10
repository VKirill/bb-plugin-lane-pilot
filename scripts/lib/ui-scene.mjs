/**
 * The decidable half of a staged scene (SMA map: Decidable half of the scene, ui-stage): the argument grammar, the address a tree's
 * window gets, the kit of trees a run may name, and the refusal of a tree without a build — all decided in code, before a browser opens.
 *
 * Grammar: [--stage] [--tree <path> | --trees a,b | --trees kit] [--port n] [--width w] <scene.json>
 * A tree's window is its dist/app.js served by a harness page on http://127.0.0.1:<4200 + sha1(tree path) mod 700>/.
 * The kit of trees is the checkout plus its git worktrees. A tree with no dist/app.js, or one older than its sources, is refused.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const USAGE = "usage: node scripts/lp-ui-drive.mjs [--stage] [--tree <path> | --trees a,b | --trees kit] [--port n] [--width w] <scene.json>";

/** A usage error: the CLI prints the message and exits 2, before anything is served or launched. */
export class SceneUsage extends Error {}

/** The scene arguments; `trees` is empty when the scene runs against a url it carries itself. */
export function parseSceneArgs(argv) {
  const args = { stage: false, trees: [], port: null, width: null, scene: null };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--stage") { args.stage = true; continue; }
    if (word === "--tree" || word === "--trees" || word === "--port" || word === "--width") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new SceneUsage(`${word} needs a value\n${USAGE}`);
      if (word === "--tree") args.trees.push(value);
      else if (word === "--trees") args.trees.push(...value.split(",").map((t) => t.trim()).filter(Boolean));
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new SceneUsage(`${word} wants a port number 1..65535\n${USAGE}`);
        args[word === "--port" ? "port" : "width"] = n;
      }
      continue;
    }
    if (word.startsWith("--")) throw new SceneUsage(`unknown flag ${word}\n${USAGE}`);
    if (args.scene) throw new SceneUsage(`one scene file only\n${USAGE}`);
    args.scene = word;
  }
  if (!args.scene) throw new SceneUsage(USAGE);
  if (!args.trees.length) args.trees = [];
  return args;
}

/** `--trees kit`: the checkout plus its git worktrees. */
export function kitOfTrees(checkoutRoot) {
  const root = resolve(checkoutRoot);
  let out = "";
  try { out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }); }
  catch { return [root]; }
  const trees = out.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length).trim());
  return [...new Set([root, ...trees])];
}

/** The address of a tree's window: one port per tree path, stable across runs and machines. */
export function treeAddress(treePath, port = null) {
  const n = port ?? 4200 + (createHash("sha1").update(resolve(treePath)).digest().readUInt32BE(0) % 700);
  return `http://127.0.0.1:${n}/`;
}

const SOURCE_EXT = new Set([".ts", ".tsx", ".vue", ".svelte", ".js", ".jsx", ".css"]);

/** The newest mtime of a source file under the tree (node_modules, .git and dist skipped). */
function newestSource(treePath) {
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of names) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path, depth + 1); continue; }
      if (!SOURCE_EXT.has(extname(entry.name))) continue;
      const mtime = statSync(path).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  };
  walk(treePath, 0);
  return newest;
}

/** Why a tree may not be staged, or null when it is built and fresh. Decided before a browser starts. */
export function treeBuildError(treePath) {
  const bundle = join(treePath, "dist", "app.js");
  if (!existsSync(bundle)) return `${treePath}: no dist/app.js — build the tree's window first`;
  const sources = newestSource(treePath);
  if (sources > statSync(bundle).mtimeMs) return `${treePath}: dist/app.js is older than the tree's sources — rebuild first`;
  return null;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".map": "application/json" };

/**
 * Raise a tree's built window: its dist/ served by a harness page (a root div plus the bundle as a module) on the port of the tree's
 * address. `close()` takes the scene down and removes the temp files. A tree without a build is refused here too.
 */
export async function serveTree(treePath, { port } = {}) {
  const error = treeBuildError(treePath);
  if (error) throw new SceneUsage(error);
  const dist = join(treePath, "dist");
  const temp = mkdtempSync(join(tmpdir(), "lp-ui-stage-"));
  liveTemps.add(temp);
  const dropTemp = () => { liveTemps.delete(temp); rmSync(temp, { recursive: true, force: true }); };
  writeFileSync(join(temp, "index.html"), "<!doctype html><meta charset=\"utf-8\"><title>lp-ui-stage</title><div id=\"root\"></div><script type=\"module\" src=\"/app.js\"></script>\n");
  const server = createServer((req, res) => {
    // A malformed %-escape is the client's mistake, not a crash of the script; a path that leaves dist/ (not a string prefix: /dist-old is a sibling) is a 404.
    let name;
    try { name = decodeURIComponent((req.url ?? "/").split("?")[0]); } catch { res.writeHead(400).end("bad request"); return; }
    const file = name === "/" ? join(temp, "index.html") : join(dist, name);
    const rel = name === "/" ? "index.html" : relative(dist, file);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  const address = treeAddress(treePath, port);
  const n = new URL(address).port;
  try { await new Promise((ok, fail) => { server.once("error", fail); server.listen(Number(n), "127.0.0.1", ok); }); }
  catch (cause) { dropTemp(); throw cause; }
  return {
    url: address, temp,
    async close() { await new Promise((ok) => server.close(ok)); dropTemp(); },
  };
}

/** Temp dirs of windows still up: removed synchronously on exit, on a crash or a signal, not only when a run ends well. */
const liveTemps = new Set();
export function cleanupStaged() { for (const dir of liveTemps) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } liveTemps.clear(); }
process.on("exit", cleanupStaged);

/** Wait for the staged page to answer; returns false when it never does. */
export async function waitForPage(url, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const res = await fetch(url); if (res.status < 500) return true; } catch { /* not up yet */ }
    await new Promise((ok) => setTimeout(ok, 200));
  }
  return false;
}
