/**
 * The catalog builder (SMA k_st_catalog): runs where the session hook runs. One builder at a time per repository (a lock file
 * with a pid and a 10-minute expiry), bounded (5000 tracked files, 60 s wall, no file read whole over 256 KB), and it
 * replaces cards.jsonl atomically and records the HEAD it built at. `startCatalogBuild` is what a session start calls:
 * it spawns no git and returns at once; the work happens in a detached process.
 */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

// The session hook runs this file as plain source (node --experimental-strip-types): a relative import needs its .ts suffix.
// @ts-expect-error TS5097
import { buildFileCard, CARD_MAX_BYTES, CARD_PEEK_BYTES } from "./card.ts";
// @ts-expect-error TS5097
import { collectGitFacts, trackedFiles } from "./git.ts";
// @ts-expect-error TS5097
import { catalogDir, findRepo, readMeta, replaceCatalog, repoHead, writeMeta } from "./store.ts";
import type { FileCard } from "./card";

export const BUILD_MAX_FILES = 5000;
export const BUILD_WALL_MS = 60_000;
export const LOCK_EXPIRY_MS = 10 * 60_000;
/** A catalog younger than this is not rebuilt for a new HEAD: cards are advice, a few commits of lag cost nothing. */
export const REBUILD_PAUSE_MS = 30 * 60_000;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; } };

function lockHeld(file: string, now: number): boolean {
  try {
    const lock = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; at?: number };
    return typeof lock.at === "number" && now - lock.at < LOCK_EXPIRY_MS && (typeof lock.pid !== "number" || alive(lock.pid));
  } catch { return false; }
}

/** Takes the build lock; false while another live builder younger than 10 minutes holds it. */
export function takeBuildLock(dir: string, now = Date.now()): boolean {
  const file = join(dir, "build.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
      closeSync(fd);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") return false;
      if (lockHeld(file, now)) return false;
      try { unlinkSync(file); } catch { return false; }
    }
  }
  return false;
}

export function releaseBuildLock(dir: string): void {
  try { unlinkSync(join(dir, "build.lock")); } catch { /* already gone */ }
}

/** A file's card; at most the first 8 KB of an over-size, secret-named or binary file is read, the rest is bounded by the size cap. */
function cardOfFile(top: string, path: string, git: { lastCommit: string | null; commits: number } | undefined): FileCard | null {
  const full = resolve(top, path);
  let info;
  try { info = lstatSync(full); } catch { return null; }
  if (!info.isFile()) return null;
  const fd = openSync(full, "r");
  try {
    const want = info.size > CARD_MAX_BYTES ? CARD_PEEK_BYTES : Math.min(info.size, CARD_MAX_BYTES);
    const buffer = Buffer.alloc(want);
    const got = want ? readSync(fd, buffer, 0, want, 0) : 0;
    return buildFileCard({ path, bytes: buffer.subarray(0, got), size: info.size, git });
  } finally { closeSync(fd); }
}

/** The cards of a checkout within the limits; `partial` when the wall limit or the file cap cut the list. */
export function collectCards(top: string, options: { maxFiles?: number; wallMs?: number; warn?: (message: string) => void; now?: () => number } = {}): { cards: FileCard[]; partial: boolean } {
  const now = options.now ?? Date.now;
  const started = now();
  const all = trackedFiles(top);
  const paths = all.slice(0, options.maxFiles ?? BUILD_MAX_FILES);
  let partial = paths.length < all.length;
  const facts = collectGitFacts(top, paths, options.warn);
  const cards: FileCard[] = [];
  for (const path of paths) {
    if (now() - started > (options.wallMs ?? BUILD_WALL_MS)) { partial = true; break; }
    try { const card = cardOfFile(top, path, facts.get(path)); if (card) cards.push(card); } catch { /* unreadable: no card */ }
  }
  return { cards, partial };
}

export type BuildResult = { ok: boolean; message: string; cards?: FileCard[] };

/** Builds and stores the catalog of the repository `cwd` belongs to. One builder at a time. */
export function buildCatalog(cwd: string, options: { maxFiles?: number; wallMs?: number; now?: () => number } = {}): BuildResult {
  const repo = findRepo(cwd);
  if (!repo) return { ok: false, message: `${cwd} is not inside a git checkout` };
  const dir = catalogDir(cwd);
  mkdirSync(dir, { recursive: true });
  if (!takeBuildLock(dir, (options.now ?? Date.now)())) return { ok: false, message: "a catalog build is already running for this repository" };
  const log = (message: string) => { try { appendFileSync(join(dir, "build.log"), `${new Date().toISOString()} ${message}\n`); } catch { /* the log is a courtesy */ } };
  const head = repoHead(repo);
  try {
    const { cards, partial } = collectCards(repo.top, { ...options, warn: log });
    replaceCatalog(cwd, cards, { head, builtAt: Date.now(), files: cards.length, ...(partial ? { partial: true } : {}) });
    return { ok: true, message: `catalog of ${cards.length} files${partial ? " (partial: limit reached)" : ""} at ${head.slice(0, 8) || "no commit"}`, cards };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log(`build failed: ${message}`);
    // Recording the HEAD with the failure stops every session start from retrying the same failing build.
    try { writeMeta(cwd, { head, builtAt: Date.now(), files: 0, error: message.slice(0, 200) }); } catch { /* nothing more to do */ }
    return { ok: false, message };
  } finally { releaseBuildLock(dir); }
}

/** True when the repository has no catalog or the catalog was built at another HEAD, and no live builder holds the lock. Reads files only. */
export function catalogNeedsBuild(cwd: string, now = Date.now()): boolean {
  const repo = findRepo(cwd);
  if (!repo) return false;
  const meta = readMeta(cwd);
  if (meta && meta.head === repoHead(repo)) return false;
  // Worktrees of one repository sit at different HEADs and share the catalog: without a pause every session start would rebuild it.
  if (meta && typeof meta.builtAt === "number" && now - meta.builtAt < REBUILD_PAUSE_MS) return false;
  return !lockHeld(join(catalogDir(cwd), "build.lock"), now);
}

/**
 * The session start's part: when the catalog is missing or stale, start the builder as a detached background process
 * (`<node> [strip-types flag] <hook file> catalog-build <cwd>`) and return at once. Never throws.
 */
export function startCatalogBuild(cwd: string, hookFile: string): boolean {
  try {
    if (!hookFile || !existsSync(hookFile) || !catalogNeedsBuild(cwd)) return false;
    const child = spawn(process.execPath, [...process.execArgv, hookFile, "catalog-build", cwd], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch { return false; }
}
