/**
 * SMA k_st_catalog: the catalog and the touch journal live outside the tracked tree at
 * `~/.lane-pilot/catalog/<repo hash>/` — cards.jsonl holds one card per path, touch.jsonl appends one line per edit the
 * session hook saw, meta.json says which HEAD the cards were built at. Worktrees stay clean.
 * The key is the repository (its git common dir), not the directory: a main checkout and all its worktrees share one
 * catalog. Nothing here spawns git: the hook calls it on every edit.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// The session hook runs this file as plain source (node --experimental-strip-types): a relative import needs its .ts suffix.
// @ts-expect-error TS5097
import { maskCredentials } from "../../../packages/kit/src/redact.ts";
import type { FileCard } from "./card";

export type Touch = { at: number; tool: string; path: string };
export type RepoRef = { top: string; gitDir: string; commonDir: string };
export type CatalogMeta = { head: string; builtAt: number; files: number; partial?: boolean; error?: string };

export const TOUCH_KEEP_LINES = 2000;
export const TOUCH_TRIM_BYTES = 1_000_000;

const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** The repository a directory belongs to, found by walking up to the nearest `.git` (a folder, or a file `gitdir: …` of a worktree). */
export function findRepo(cwd: string): RepoRef | null {
  if (!cwd || !isAbsolute(cwd)) return null;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dot = join(dir, ".git");
    try {
      const info = lstatSync(dot);
      if (info.isDirectory()) return { top: dir, gitDir: dot, commonDir: dot };
      if (info.isFile()) {
        const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
        if (!target) return null;
        const gitDir = resolve(dir, target);
        let commonDir = gitDir;
        try { commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()); } catch { /* a plain gitdir (submodule): its own common dir */ }
        return { top: dir, gitDir, commonDir };
      }
    } catch { /* no .git here: go up */ }
    if (dirname(dir) === dir) return null;
  }
}

/** The commit HEAD points at, read from files (HEAD, the ref, packed-refs); "" for an unborn branch. */
export function repoHead(repo: RepoRef): string {
  try {
    const head = readFileSync(join(repo.gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return head;
    for (const base of [repo.gitDir, repo.commonDir]) {
      try { const sha = readFileSync(join(base, ref), "utf8").trim(); if (sha) return sha; } catch { /* try the next place */ }
    }
    for (const line of readFileSync(join(repo.commonDir, "packed-refs"), "utf8").split("\n")) if (line.endsWith(` ${ref}`)) return line.split(" ")[0]!;
  } catch { /* unreadable HEAD: unknown */ }
  return "";
}

/** The state folder of one repository; a directory outside any repo falls back to its own path. */
export function catalogDir(cwd: string): string {
  const repo = findRepo(cwd);
  const key = createHash("sha256").update(repo ? real(repo.commonDir) : real(cwd)).digest("hex").slice(0, 16);
  return join(homedir(), ".lane-pilot", "catalog", key);
}

export const catalogExists = (cwd: string): boolean => existsSync(join(catalogDir(cwd), "cards.jsonl"));

function parseLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* one bad line is skipped, the rest still count */ }
  }
  return out;
}

export function readCatalog(cwd: string): FileCard[] {
  try { return parseLines<FileCard>(readFileSync(join(catalogDir(cwd), "cards.jsonl"), "utf8")); } catch { return []; }
}

export function readMeta(cwd: string): CatalogMeta | null {
  try { return JSON.parse(readFileSync(join(catalogDir(cwd), "meta.json"), "utf8")) as CatalogMeta; } catch { return null; }
}

function atomicWrite(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

/** Stores cards replacing same-path entries, atomically (temp file then rename). */
export function writeCatalog(cwd: string, cards: readonly FileCard[]): void {
  const dir = catalogDir(cwd);
  mkdirSync(dir, { recursive: true });
  const byPath = new Map<string, FileCard>();
  for (const card of readCatalog(cwd)) byPath.set(card.path, card);
  for (const card of cards) byPath.set(card.path, card);
  const body = [...byPath.values()].map((card) => JSON.stringify(card)).join("\n");
  atomicWrite(join(dir, "cards.jsonl"), body ? `${body}\n` : "");
}

export function writeMeta(cwd: string, meta: CatalogMeta): void {
  const dir = catalogDir(cwd);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, "meta.json"), JSON.stringify(meta));
}

/** The builder's write: the cards replace the whole catalog, then meta.json records the HEAD they were built at. */
export function replaceCatalog(cwd: string, cards: readonly FileCard[], meta: CatalogMeta): void {
  const dir = catalogDir(cwd);
  mkdirSync(dir, { recursive: true });
  const body = cards.map((card) => JSON.stringify(card)).join("\n");
  atomicWrite(join(dir, "cards.jsonl"), body ? `${body}\n` : "");
  writeMeta(cwd, meta);
}

/**
 * One touch line per edit tool call the hook saw. Only where a catalog already exists (never a new folder for a repo
 * nobody cataloged); the file keeps its newest TOUCH_KEEP_LINES lines once it passes about 1 MB.
 */
export function appendTouch(cwd: string, touch: Touch): void {
  const dir = catalogDir(cwd);
  if (!existsSync(join(dir, "cards.jsonl"))) return;
  const file = join(dir, "touch.jsonl");
  appendFileSync(file, `${JSON.stringify(touch)}\n`);
  if (statSync(file).size > TOUCH_TRIM_BYTES) {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    atomicWrite(file, `${lines.slice(-TOUCH_KEEP_LINES).join("\n")}\n`);
  }
}

export function readTouches(cwd: string): Touch[] {
  try { return parseLines<Touch>(readFileSync(join(catalogDir(cwd), "touch.jsonl"), "utf8")); } catch { return []; }
}

/** The one card line of a repo-relative path, found by scanning for its line so the whole catalog is not parsed. */
function cardOf(cwd: string, rel: string): FileCard | null {
  const file = join(catalogDir(cwd), "cards.jsonl");
  let text: string;
  try { if (statSync(file).size > 16_000_000) return null; text = readFileSync(file, "utf8"); } catch { return null; }
  const needle = `{"path":${JSON.stringify(rel)},`;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    if (at !== 0 && text[at - 1] !== "\n") continue;
    const end = text.indexOf("\n", at);
    try { return JSON.parse(text.slice(at, end < 0 ? undefined : end)) as FileCard; } catch { /* a bad line: not this card */ }
  }
  return null;
}

/** The card lines the knowledge stream shows for an edited path: the hook's path may be absolute, the catalog stores repo-relative ones. */
export function cardNotes(cwd: string, path: string): Array<{ claim: string }> {
  if (!path) return [];
  const repo = findRepo(cwd);
  const normal = path.replace(/\\/g, "/");
  const root = (repo?.top ?? cwd).replace(/\\/g, "/");
  const rel = normal.startsWith(`${root}/`) ? normal.slice(root.length + 1) : normal;
  const card = cardOf(cwd, rel);
  if (!card) return [];
  // The card was masked when built; a catalog written by an older build or by hand is masked again here.
  const head = card.headLine ? ` — ${card.headLine}` : "";
  const claim = card.skipped ? `${card.path}: ${card.bytes} bytes (${card.skipped}, not read)` : `${card.path}: ${card.lines} lines of ${card.language}${card.lastCommit ? `, last change ${card.lastCommit.slice(0, 8)}` : ""}${head}`;
  return [{ claim: maskCredentials(claim).text }];
}
