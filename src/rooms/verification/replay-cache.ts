import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawnAsync, sha256Hex } from "@lane-pilot/kit";

/**
 * The verdicts a worktree's replay checks settled, per worktree revision (`lp-replay-checks.json` in the worktree's git
 * admin dir — it goes away with the worktree). Keyed by the worktree head, then by the check's command + cwd: a retried
 * integration (hub restart mid-merge, a queue retry, a rebase that lands on the same tip) reuses the verdict instead of
 * running the suite again, and a merge that would proceed without a replay still honours a recorded red. Only settled
 * results are kept: a check the machine broke is not written, so it runs again.
 * graphs-optimisation G8: a repeat of a check on the same revision is spent minutes, not evidence.
 */
export type ReplayCacheEntry = { command:string; cwd?:string; exitCode:number; stdout:string; stderr:string };
type ReplayCacheFile = Record<string, Record<string, ReplayCacheEntry>>;

const FILE = "lp-replay-checks.json";
const TAIL = 4000;

const gitLine = async (cwd: string, args: string[]): Promise<string | null> => {
  const out = await spawnAsync("git", args, { cwd, timeout: 15_000 });
  return out.status === 0 ? (out.stdout.trim() || null) : null;
};

export const replayKey = (command: string, cwd: string | undefined): string => sha256Hex(`${cwd ?? ""}\n${command}`);

/** The worktree's head and where its replay cache lives, or null when git cannot answer (nothing is cached then). */
export async function replayCacheLocation(worktreePath: string): Promise<{ head: string; path: string } | null> {
  const head = await gitLine(worktreePath, ["rev-parse", "HEAD"]);
  if (!head) return null;
  const dir = await gitLine(worktreePath, ["rev-parse", "--git-dir"]);
  if (!dir) return null;
  return { head, path: join(isAbsolute(dir) ? dir : resolve(worktreePath, dir), FILE) };
}

async function load(path: string): Promise<ReplayCacheFile> {
  return readFile(path, "utf8").then((text) => JSON.parse(text) as ReplayCacheFile).catch(() => ({}));
}

/** What the cache already settled for these checks on this revision, in command order (missing keys stay out). */
export async function cachedReplayVerdicts(worktreePath: string, commands: readonly { command: string; cwd?: string }[]): Promise<{ head: string; path: string; entries: Record<string, ReplayCacheEntry> } | null> {
  const at = await replayCacheLocation(worktreePath);
  if (!at) return null;
  const file = await load(at.path);
  const perHead = file[at.head] ?? {};
  const entries: Record<string, ReplayCacheEntry> = {};
  for (const check of commands) {
    const key = replayKey(check.command, check.cwd);
    if (perHead[key]) entries[key] = perHead[key]!;
  }
  return { ...at, entries };
}

/** Records a settled verdict for one check on the worktree's current head. Best-effort: a write failure loses the memo, not the merge. */
export async function recordReplayVerdict(worktreePath: string, command: string, cwd: string | undefined, entry: { exitCode: number; stdout: string; stderr: string }): Promise<void> {
  const at = await replayCacheLocation(worktreePath);
  if (!at) return;
  const file = await load(at.path);
  const perHead = file[at.head] ?? (file[at.head] = {});
  perHead[replayKey(command, cwd)] = { command, cwd, exitCode: entry.exitCode, stdout: entry.stdout.slice(-TAIL), stderr: entry.stderr.slice(-TAIL) };
  await writeFile(at.path, JSON.stringify(file)).catch(() => {});
}

/** The recorded red of this worktree's current head, or null: lets a merge that skips the replay still see its verdict. */
export async function recordedReplayFailure(worktreePath: string): Promise<ReplayCacheEntry | null> {
  const at = await replayCacheLocation(worktreePath);
  if (!at) return null;
  const perHead = (await load(at.path))[at.head] ?? {};
  return Object.values(perHead).find((entry) => entry.exitCode !== 0) ?? null;
}
