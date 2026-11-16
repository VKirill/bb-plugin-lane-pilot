import { runOnHost } from "@lane-pilot/host-calls";
import { bestEffort } from "@lane-pilot/kit";
import { dependencyChangeProofRows, readRevertIntents } from "../../rollback/server";
import { dependsOnTask } from "../../tasks";
import type { ServerCore } from "../../contracts/server";

export type DependencyMerge = { dep: string; taskId: string; commit: string };

/**
 * The merge commit of each accepted dependency, inside the task's own run: the latest accepted member of the name's family
 * («d-c» follows «d-c.2»). A dependency accepted without a merge (no code changed, a folder without git, satisfied by the PM)
 * has nothing to prove and is left out.
 */
export function dependencyMerges(db: ServerCore["db"], runId: string, dependsOn: readonly string[]): DependencyMerge[] {
  const rows = dependencyChangeProofRows(db as never, runId);
  const merges: DependencyMerge[] = [];
  const selectedTasks = new Set<string>();
  for (const dep of new Set(dependsOn)) {
    const row = rows.filter((candidate) => dependsOnTask([dep], candidate.task_id)).at(-1);
    if (!row) continue;
    if (row.run_id !== runId || row.attempt_run_id !== runId || row.attempt_task_id !== row.task_id) {
      throw new Error(`accepted dependency ${row.task_id} has mismatched attempt provenance`);
    }
    if (row.outcome === "reverted") {
      // The historical accepted row remains visible for rollback/status, but it cannot satisfy a
      // new dependent: the original merge is still an ancestor after `git revert` while its tree is gone.
      throw new Error(`accepted dependency ${row.task_id} was reverted`);
    }
    if (typeof row.merge_commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(row.merge_commit)) {
      // A non-null merge is provenance, not an optional hint. Do not turn malformed persisted
      // provenance into the intentional no-merge case, and never interpolate it into a shell command.
      throw new Error(`invalid accepted dependency merge commit for ${row.task_id}`);
    }
    // `dep` and `dep.2` can both resolve to the same accepted family member. One proof per
    // selected task keeps the command and its diagnostics canonical without weakening the check.
    if (selectedTasks.has(row.task_id)) continue;
    selectedTasks.add(row.task_id);
    merges.push({ dep, taskId: row.task_id, commit: row.merge_commit });
  }
  return merges;
}

/**
 * The owner's rule (ТЗ sma-parity 4д.3): a task starts from a `main` that holds its dependencies' merges. The worktree is cut from the
 * base checkout's HEAD after the dependencies were accepted, and «accepted» is written only after the merge; this proves it on the
 * worktree itself — every dependency's merge commit must be an ancestor of the workspace's HEAD. `missing` lists the ones that are not;
 * null when git could not be asked or returned an untrusted answer.
 */
export async function checkDependencyBase(core: Pick<ServerCore, "bb" | "db" | "host">, input: { runId: string; hostId: string; workspacePath: string; dependsOn: readonly string[] },
  log: (line: string) => void): Promise<{ head: string; checked: DependencyMerge[]; missing: DependencyMerge[] } | null> {
  let merges: DependencyMerge[];
  try {
    merges = dependencyMerges(core.db, input.runId, input.dependsOn);
    // Query the declared family even when its accepted row has no merge commit: a rollback intent is an unresolved
    // effect, not the intentional no-merge exception. Alias rows are added below so dep.2 also sees an intent keyed by dep.
    const proofRows = dependencyChangeProofRows(core.db as never, input.runId);
    const intentTaskIds = new Set(input.dependsOn);
    for (const row of proofRows) if (input.dependsOn.some((dep) => dependsOnTask([dep], row.task_id))) intentTaskIds.add(row.task_id);
    for (const taskId of intentTaskIds) {
      const intent = await readRevertIntents(core.bb.storage.kv as never, input.runId, taskId);
      if (intent.state !== "none") throw new Error(intent.state === "pending"
        ? `accepted dependency ${taskId} has a pending rollback intent (${intent.intent.opId})`
        : `accepted dependency ${taskId} rollback intent is unknown: ${intent.reason}`);
    }
  } catch {
    return null;
  }
  if (!merges.length) return { head: "", checked: [], missing: [] };
  // Keep each ancestry probe's exit status visible. A plain `;` chain lets a failed rev-parse be
  // hidden by a later successful `echo`, and a host that answers with malformed output must not
  // be treated as proof that the worktree is safe to start.
  const command = [
    'head="$(git rev-parse --verify HEAD)" || exit $?; printf "HEAD %s\\n" "$head"',
    ...merges.map((merge) => `git merge-base --is-ancestor ${merge.commit} HEAD; status=$?; if [ "$status" -eq 0 ]; then printf "OK ${merge.commit}\\n"; elif [ "$status" -eq 1 ]; then printf "MISSING ${merge.commit}\\n"; else exit "$status"; fi`),
  ].join("; ");
  const ran = await bestEffort(log, "writer dependency base probe", runOnHost(core.host, { hostId: input.hostId, cwd: input.workspacePath, command, timeoutSec: 30, timeoutMs: 45_000 }), null);
  if (!ran || ran.exitCode !== 0) return null;
  const lines = ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  // `rev-parse --verify HEAD` emits a complete object id, never an abbreviated id. Keep this
  // stricter than the stored merge-commit check so a truncated host answer cannot prove a base.
  const head = lines.shift()?.match(/^HEAD ([0-9a-f]{40}|[0-9a-f]{64})$/i)?.[1];
  if (!head || lines.length !== merges.length) return null;
  const outcomes = new Map<string, "OK" | "MISSING">();
  for (const line of lines) {
    const match = line.match(/^(OK|MISSING) ([0-9a-f]{7,64})$/i);
    if (!match || outcomes.has(match[2]!)) return null;
    outcomes.set(match[2]!, match[1]!.toUpperCase() as "OK" | "MISSING");
  }
  if (merges.some((merge) => outcomes.get(merge.commit) === undefined)) return null;
  return { head, checked: merges, missing: merges.filter((merge) => outcomes.get(merge.commit) === "MISSING") };
}
