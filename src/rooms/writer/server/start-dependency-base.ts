import { runOnHost } from "@lane-pilot/host-calls";
import { bestEffort } from "@lane-pilot/kit";
import { acceptedChangeProofRows } from "../../rollback/server";
import { dependsOnTask } from "../../tasks";
import type { ServerCore } from "../../contracts/server";

export type DependencyMerge = { dep: string; taskId: string; commit: string };

/**
 * The merge commit of each accepted dependency, inside the task's own run: the latest accepted member of the name's family
 * («d-c» follows «d-c.2»). A dependency accepted without a merge (no code changed, a folder without git, satisfied by the PM)
 * has nothing to prove and is left out.
 */
export function dependencyMerges(db: ServerCore["db"], runId: string, dependsOn: readonly string[]): DependencyMerge[] {
  const rows = acceptedChangeProofRows(db as never, runId);
  const merges: DependencyMerge[] = [];
  for (const dep of new Set(dependsOn)) {
    const row = rows.filter((candidate) => dependsOnTask([dep], candidate.task_id)).at(-1);
    if (row && /^[0-9a-f]{7,64}$/i.test(row.merge_commit)) merges.push({ dep, taskId: row.task_id, commit: row.merge_commit });
  }
  return merges;
}

/**
 * The owner's rule (ТЗ sma-parity 4д.3): a task starts from a `main` that holds its dependencies' merges. The worktree is cut from the
 * base checkout's HEAD after the dependencies were accepted, and «accepted» is written only after the merge; this proves it on the
 * worktree itself — every dependency's merge commit must be an ancestor of the workspace's HEAD. `missing` lists the ones that are not;
 * null when git could not be asked (the start is not held by a machine that does not answer: the log says it went unproven).
 */
export async function checkDependencyBase(core: Pick<ServerCore, "db" | "host">, input: { runId: string; hostId: string; workspacePath: string; dependsOn: readonly string[] },
  log: (line: string) => void): Promise<{ head: string; checked: DependencyMerge[]; missing: DependencyMerge[] } | null> {
  const merges = dependencyMerges(core.db, input.runId, input.dependsOn);
  if (!merges.length) return { head: "", checked: [], missing: [] };
  const command = ["git rev-parse HEAD", ...merges.map((merge) => `git merge-base --is-ancestor ${merge.commit} HEAD || echo MISSING ${merge.commit}`)].join("; ");
  const ran = await bestEffort(log, "writer dependency base probe", runOnHost(core.host, { hostId: input.hostId, cwd: input.workspacePath, command, timeoutSec: 30, timeoutMs: 45_000 }), null);
  if (!ran || ran.exitCode !== 0) return null;
  const lines = ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const absent = new Set(lines.filter((line) => line.startsWith("MISSING ")).map((line) => line.slice(8)));
  return { head: lines[0] ?? "", checked: merges, missing: merges.filter((merge) => absent.has(merge.commit)) };
}
