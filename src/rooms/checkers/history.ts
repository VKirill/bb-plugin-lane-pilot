import { taskV2Schema } from "../contracts";
import { MAX_FILE_EXCERPT_BYTES } from "../critique";
import type { LoadedCandidate } from "./api";
import { plantAll } from "./mutators";
import { sha256, type FileChange } from "./types";
import { openClone, quote, type ShellResult } from "./workspace";

/** The slice of a bench candidate this needs (src/rooms/bench/types.ts `Candidate`). */
export type HistoryCandidate = { taskId: string; projectId: string; hostId: string; repoPath: string; contract: Record<string, unknown> };

export type HistoryDeps = {
  candidates: () => readonly HistoryCandidate[];
  /** `findSolutionCommit` of the bench: the commit that merged the accepted attempt of a task. */
  solutionCommit: (candidate: HistoryCandidate) => Promise<{ commit: string } | { reason: string; detail: string }>;
  host: { run(hostId: string, cwd: string, command: string, timeoutSec?: number): Promise<ShellResult> };
  /** A folder for the clones on that machine. */
  scratch: (hostId: string) => string;
  log: (line: string) => void;
};

const MAX_FILES = 8, MAX_CHANGED_LINES = 600, MAX_FILE_BYTES = 60_000, MIN_PLANTABLE = 3;
const SKIP_PATH = /(^|\/)(?:node_modules|dist|build|\.agents|\.next|coverage)\/|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.min\.js|\.snap)$/;

/**
 * Real accepted candidates from the history: for each, the files the accepted solution changed (before and after) and a clone-backed way to run
 * its checks. Small ones only (a few files, a few hundred lines, text), and the ones that can carry the most defect classes first. Which tasks
 * are tried is fixed by a hash of the task id, so the same history gives the same scorecard.
 */
export async function loadHistory(deps: HistoryDeps, options: { limit: number; only?: readonly string[]; checkTimeoutSec?: number }): Promise<LoadedCandidate[]> {
  const pool = deps.candidates().filter((candidate) => !options.only || options.only.includes(candidate.taskId))
    .sort((a, b) => (sha256(a.taskId) < sha256(b.taskId) ? -1 : 1));
  const found: Array<{ row: LoadedCandidate; plantable: number }> = [];
  let probed = 0;
  for (const candidate of pool) {
    if (found.length >= options.limit * 3 || probed >= options.limit * 10) break;
    probed++;
    const skip = (why: string) => deps.log(`skipped ${candidate.taskId}: ${why}`);
    const parsed = taskV2Schema.safeParse(candidate.contract);
    if (!parsed.success) { skip("its contract does not parse as task-v2"); continue; }
    const run = (command: string, timeout = 60) => deps.host.run(candidate.hostId, candidate.repoPath, command, timeout).catch((cause: unknown): ShellResult => ({ exitCode: 255, stdout: "", stderr: String(cause) }));
    const solved = await deps.solutionCommit(candidate);
    if ("reason" in solved) { skip(`${solved.reason} ${solved.detail}`); continue; }
    const sol = solved.commit;
    const parent = await run(`git rev-parse ${quote(`${sol}^1`)}`);
    const base = parent.stdout.trim();
    if (parent.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(base)) { skip("the solution commit has no parent"); continue; }
    const stat = await run(`git diff --numstat --no-renames ${quote(base)} ${quote(sol)}`);
    const status = await run(`git diff --name-status --no-renames ${quote(base)} ${quote(sol)}`);
    if (stat.exitCode !== 0 || status.exitCode !== 0) { skip("could not read the diff"); continue; }
    const counts = stat.stdout.split("\n").filter(Boolean).map((line) => line.split("\t"));
    if (counts.some(([added]) => added === "-")) { skip("the diff has a binary file"); continue; }
    const letters = new Map(status.stdout.split("\n").filter(Boolean).map((line) => { const [letter = "", path = ""] = line.split("\t"); return [path, letter] as const; }));
    const paths = [...letters.keys()];
    if (!paths.length || paths.length > MAX_FILES) { skip(`${paths.length} changed files`); continue; }
    if (paths.some((path) => SKIP_PATH.test(path))) { skip("the diff touches lockfiles or generated files"); continue; }
    if (counts.reduce((sum, [added = "0", removed = "0"]) => sum + Number(added) + Number(removed), 0) > MAX_CHANGED_LINES) { skip("the diff is too large"); continue; }
    const changes: FileChange[] = [];
    let readable = true;
    for (const path of paths) {
      const letter = letters.get(path)!;
      const after = letter === "D" ? { exitCode: 0, stdout: null } : await run(`git show ${quote(`${sol}:${path}`)}`);
      const before = letter === "A" ? { exitCode: 0, stdout: null } : await run(`git show ${quote(`${base}:${path}`)}`);
      if (after.exitCode !== 0 || before.exitCode !== 0) { readable = false; break; }
      if ([after.stdout, before.stdout].some((text) => text !== null && (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES || text.includes("\0")))) { readable = false; break; }
      changes.push({ path, before: before.stdout, after: after.stdout });
    }
    if (!readable) { skip("a changed file is too large, binary or unreadable"); continue; }
    const input = { taskId: candidate.taskId, contract: parsed.data, changes, source: `history:${candidate.taskId}` };
    // Files the code critic can see whole (it is shown the first 8 KB of a file) rank first: a defect past that is invisible to it.
    const fits = changes.every((change) => [change.after, change.before].every((text) => text === null || Buffer.byteLength(text, "utf8") <= MAX_FILE_EXCERPT_BYTES));
    const plantable = plantAll(input).length;
    if (plantable < MIN_PLANTABLE) { skip(`only ${plantable} defect classes fit`); continue; }
    const hostId = candidate.hostId, shell = { run: (cwd: string, command: string, timeout?: number) => deps.host.run(hostId, cwd, command, timeout) };
    found.push({
      plantable: plantable + (fits ? 10 : 0),
      row: { input, where: { projectId: candidate.projectId, hostId, path: candidate.repoPath }, open: () => openClone(shell, { repo: candidate.repoPath, baseSha: base, scratch: deps.scratch(hostId), name: candidate.taskId, ...(options.checkTimeoutSec ? { checkTimeoutSec: options.checkTimeoutSec } : {}) }) },
    });
    deps.log(`candidate ${candidate.taskId}: ${paths.length} files, ${plantable} defect classes fit`);
  }
  return found.sort((a, b) => b.plantable - a.plantable || (a.row.input.taskId < b.row.input.taskId ? -1 : 1)).slice(0, options.limit).map((entry) => entry.row);
}
