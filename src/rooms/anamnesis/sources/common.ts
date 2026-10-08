import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Kind, Sensitivity, Source } from "../model";

/** What a host-side source hands back: records for the store, and how many things it looked at. */
export type SourceRecord = {
  kind: Kind; key: string; title: string; statement?: string; attributes?: Record<string, unknown>; sensitivity?: Sensitivity;
  confidence?: number; status?: "candidate" | "draft"; firstSeen?: number; lastSeen?: number;
  evidence: Array<{ source: Source; ref: string; at: number; quote?: string }>;
};
export type SourceScan = { source: Source; items: number; records: SourceRecord[]; note?: string };

export const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", ".bb", ".cache", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".turbo", "Library", ".Trash", "coverage", ".gitnexus", ".agents"]);

export async function isDir(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}
export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/** Git repositories under the roots (a `.git` folder; a `.git` file is a worktree and is left to its main repository). */
export async function discoverRepos(roots: readonly string[], maxDepth = 5): Promise<string[]> {
  const found = new Set<string>();
  async function walk(dir: string, depth: number): Promise<void> {
    if (await isDir(join(dir, ".git"))) { found.add(dir); return; }
    if (depth >= maxDepth) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  }
  for (const root of roots) await walk(root, 0);
  return [...found].sort();
}

/** `git` read-only: no index refresh, no prompts. */
export function runGit(args: string[], cwd: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/** n evenly spread items, always keeping the first and the last. */
export function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]!);
  return out;
}

export const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7);
export const homeRelative = (path: string, home: string): string => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** A folder of the owner's clients: its projects are not for a portfolio. */
export const isClientPath = (path: string): boolean => /клиент|\bclients?\b/i.test(path);
