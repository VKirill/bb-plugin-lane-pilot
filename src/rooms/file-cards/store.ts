/**
 * SMA k_st_catalog: the catalog and the touch journal live outside the tracked tree at
 * `~/.lane-pilot/catalog/<repo hash>/` — cards.jsonl holds one card per path (a write replaces
 * by path), touch.jsonl appends one line per edit the session hook saw. Worktrees stay clean.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { FileCard } from "./card";

export type Touch = { at: number; tool: string; path: string };

/** The state folder of one checkout; the hash is of the directory both writer and reader pass. */
export function catalogDir(cwd: string): string {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(homedir(), ".lane-pilot", "catalog", key);
}

export function readCatalog(cwd: string): FileCard[] {
  const file = join(catalogDir(cwd), "cards.jsonl");
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FileCard);
  } catch { return []; }
}

/** Stores cards replacing same-path entries, atomically (temp file then rename). */
export function writeCatalog(cwd: string, cards: readonly FileCard[]): void {
  const dir = catalogDir(cwd);
  mkdirSync(dir, { recursive: true });
  const byPath = new Map<string, FileCard>();
  for (const card of readCatalog(cwd)) byPath.set(card.path, card);
  for (const card of cards) byPath.set(card.path, card);
  const body = [...byPath.values()].map((card) => JSON.stringify(card)).join("\n");
  const tmp = join(dir, `cards.jsonl.${process.pid}.tmp`);
  writeFileSync(tmp, body ? `${body}\n` : "");
  renameSync(tmp, join(dir, "cards.jsonl"));
}

/** One touch line per edit tool call the hook saw. */
export function appendTouch(cwd: string, touch: Touch): void {
  const dir = catalogDir(cwd);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "touch.jsonl"), `${JSON.stringify(touch)}\n`);
}

export function readTouches(cwd: string): Touch[] {
  const file = join(catalogDir(cwd), "touch.jsonl");
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Touch);
  } catch { return []; }
}

/** The card lines the knowledge stream shows for an edited path: the hook's path may be absolute, the catalog stores repo-relative ones. */
export function cardNotes(cwd: string, path: string): Array<{ claim: string }> {
  const rel = path.replace(/\\/g, "/");
  const local = rel.startsWith(`${cwd}/`) ? rel.slice(cwd.length + 1) : rel;
  const card = readCatalog(cwd).find((entry) => entry.path === local || entry.path === rel);
  if (!card) return [];
  const head = card.headLine ? ` — ${card.headLine}` : "";
  return [{ claim: `${card.path}: ${card.lines} lines of ${card.language}${card.lastCommit ? `, last change ${card.lastCommit.slice(0, 8)}` : ""}${head}` }];
}
