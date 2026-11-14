import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";

/**
 * The code facts of a project (SMA k_t_intel / k_pl_intel): the GitNexus index under `.gitnexus/`, whether it still
 * matches HEAD, and the one command that refreshes it. meta.json's lastCommit is the commit the index was built at.
 */
export type CodeFacts = { state: "none" } | { state: "fresh" } | { state: "stale"; behind: number | null };

/** One shell read on the project's host: NONE without an index, else HEAD, the indexed commit and how far it lags. */
export const CODE_FACTS_PROBE = [
  `if [ ! -d .gitnexus ]; then echo NONE; else`,
  `echo "HEAD=$(git rev-parse HEAD 2>/dev/null)";`,
  `last=$(sed -n 's/.*"lastCommit"[^"]*"\\([^"]*\\)".*/\\1/p' .gitnexus/meta.json 2>/dev/null | head -1);`,
  `echo "LAST=$last";`,
  `if [ -n "$last" ]; then echo "BEHIND=$(git rev-list --count "$last..HEAD" 2>/dev/null)"; else echo "BEHIND="; fi;`,
  `fi`,
].join(" ");

/** The refresh itself: GitNexus re-analyzes the repository and rebuilds its .gitnexus store. */
export const CODE_FACTS_REFRESH = "gitnexus analyze --index-only";

/** The state of the index from the probe output: none, fresh, or stale by so many commits (count unknown: null). */
export function codeFactsState(probe: string | null | undefined): CodeFacts {
  if (!probe || /^NONE/m.test(probe)) return { state: "none" };
  const head = /^HEAD=([0-9a-f]{7,40})/im.exec(probe)?.[1] ?? null;
  const last = /^LAST=([0-9a-f]{7,40})/im.exec(probe)?.[1] ?? null;
  const behind = /^BEHIND=(\d+)/m.exec(probe)?.[1];
  if ((head && last && head === last) || behind === "0") return { state: "fresh" };
  return { state: "stale", behind: behind !== undefined && behind !== "" ? Number(behind) : null };
}

/** The code facts of a checkout on a machine; an unreadable probe reads as none. */
export async function codeFactsOnHost(host: RunCommandHost, hostId: string, cwd: string): Promise<CodeFacts> {
  const probe = await runOnHost(host, { hostId, cwd, command: CODE_FACTS_PROBE, timeoutSec: 30 }).catch(() => null);
  return codeFactsState(probe?.stdout ?? null);
}
