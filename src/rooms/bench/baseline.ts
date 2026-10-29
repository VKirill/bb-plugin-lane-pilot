import { matchOwnsPath } from "@lane-pilot/kit";
import type { HostPort } from "./ports";
import { q } from "./ports";
import type { BenchDb } from "./store";

/**
 * The baseline metric bench (SMA k_lib_bench «No model: false-done rate, git loss recoverability, phantom writes»): three numbers with no
 * model in them, read from what the pipeline recorded about the accepted attempts of a window. Before (SMA conformance audit C-07) the
 * map pointed this card at the weekly model bench (weekArm), which measures none of them.
 *  - false done: an accepted task the record contradicts later — a regression found on it (lane_pilot_regression, as the task or the
 *    culprit), a merged revert of it (lane_pilot_task_receipt), or a repair task <id>-mainfix made for it.
 *  - phantom writes: an accepted attempt whose contract names expected_outputs its merge did not change (lane_pilot_attempt_change):
 *    work reported done that git does not hold.
 *  - git loss recoverability: of the accepted attempts that merged, the share whose merge commit still exists in their checkout
 *    (git cat-file -e on the run's writer host), so work lost from main can be taken back from it.
 */
export type BaselineMetrics = {
  window: { since: number; until: number; projectId: string | null };
  accepted: number;
  falseDone: { count: number; rate: number | null; tasks: string[] };
  phantomWrites: { count: number; rate: number | null; measured: number; unmeasured: number; attempts: Array<{ attemptId: string; taskId: string; missing: string[] }> };
  gitLoss: { merged: number; checked: number; recoverable: number; rate: number | null; lost: string[]; unchecked: number };
};

type Row = { attemptId: string; taskId: string; projectId: string; hostId: string | null; workspace: string | null; contract: string; mergeCommit: string | null; changed: string | null };

const rate = (count: number, of: number) => (of ? Math.round((count / of) * 1000) / 1000 : null);

export async function baselineMetrics(db: BenchDb, host: HostPort | null, opts: { days?: number; projectId?: string; now?: number } = {}): Promise<BaselineMetrics> {
  const until = opts.now ?? Date.now();
  const since = until - (opts.days ?? 14) * 86_400_000;
  const rows = db.prepare(`SELECT a.id AS attemptId, a.task_id AS taskId, r.project_id AS projectId, r.writer_host_id AS hostId, r.writer_workspace_path AS workspace,
      t.contract_json AS contract, c.merge_commit AS mergeCommit, c.changed_json AS changed
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id = a.run_id JOIN lane_pilot_task t ON t.id = a.task_id
    LEFT JOIN lane_pilot_attempt_change c ON c.attempt_id = a.id
    WHERE a.state = 'accepted' AND a.updated_at >= ? AND a.updated_at < ? AND (? IS NULL OR r.project_id = ?)`).all(since, until, opts.projectId ?? null, opts.projectId ?? null) as Row[];
  const tasks = [...new Set(rows.map((row) => row.taskId))];

  const contradicted = new Set<string>();
  for (const id of tasks) {
    const regression = db.prepare("SELECT 1 FROM lane_pilot_regression WHERE kind = 'regression' AND (task_id = ? OR culprit_task = ?) LIMIT 1").get(id, id);
    const revert = db.prepare("SELECT 1 FROM lane_pilot_task_receipt WHERE kind = 'revert' AND state = 'merged' AND task_id = ? LIMIT 1").get(id);
    const mainfix = db.prepare("SELECT 1 FROM lane_pilot_task WHERE id = ? LIMIT 1").get(`${id}-mainfix`);
    if (regression || revert || mainfix) contradicted.add(id);
  }

  const phantom: BaselineMetrics["phantomWrites"]["attempts"] = [];
  // An attempt with no change record says nothing about what it wrote: it is unmeasured, never a phantom write.
  const recorded = rows.filter((row) => row.changed !== null);
  for (const row of recorded) {
    let expected: string[] = [];
    try { expected = ((JSON.parse(row.contract) as { expected_outputs?: unknown }).expected_outputs as string[] | undefined)?.filter((entry) => typeof entry === "string") ?? []; } catch { /* no contract: nothing expected */ }
    if (!expected.length) continue;
    let changed: string[] = [];
    try { changed = (JSON.parse(row.changed ?? "[]") as Array<{ path?: string }>).map((entry) => entry.path ?? "").filter(Boolean); } catch { /* unreadable: nothing changed */ }
    // A nested project folder writes its paths under the repository's prefix: an output matches the changed path or its tail.
    const missing = expected.filter((entry) => !changed.some((path) => matchOwnsPath(path, entry) || path.endsWith(`/${entry.replace(/^\.\//, "")}`)));
    if (missing.length) phantom.push({ attemptId: row.attemptId, taskId: row.taskId, missing: missing.slice(0, 5) });
  }

  const merged = rows.filter((row) => row.mergeCommit);
  const lost: string[] = [];
  let checked = 0, recoverable = 0;
  if (host) {
    const groups = new Map<string, Row[]>();
    for (const row of merged) if (row.hostId && row.workspace) groups.set(`${row.hostId}\n${row.workspace}`, [...(groups.get(`${row.hostId}\n${row.workspace}`) ?? []), row]);
    for (const [key, group] of groups) {
      const [hostId, cwd] = key.split("\n") as [string, string];
      const shas = [...new Set(group.map((row) => row.mergeCommit!))].slice(0, 400);
      const ran = await host.run(hostId, cwd, `for s in ${shas.map(q).join(" ")}; do if git cat-file -e "$s^{commit}" 2>/dev/null; then echo "ok $s"; else echo "lost $s"; fi; done`, 120)
        .catch(() => ({ exitCode: -1, stdout: "", stderr: "" }));
      const seen = new Map(ran.stdout.split("\n").map((line) => line.trim().split(" ") as [string, string]).filter(([state, sha]) => sha && (state === "ok" || state === "lost")).map(([state, sha]) => [sha, state]));
      for (const sha of shas) {
        const state = seen.get(sha);
        if (!state) continue;
        checked++;
        if (state === "ok") recoverable++; else lost.push(sha);
      }
    }
  }
  return {
    window: { since, until, projectId: opts.projectId ?? null },
    accepted: tasks.length,
    falseDone: { count: contradicted.size, rate: rate(contradicted.size, tasks.length), tasks: [...contradicted].slice(0, 50) },
    phantomWrites: { count: phantom.length, rate: rate(phantom.length, recorded.length), measured: recorded.length, unmeasured: rows.length - recorded.length, attempts: phantom.slice(0, 50) },
    gitLoss: { merged: merged.length, checked, recoverable, rate: rate(recoverable, checked), lost: lost.slice(0, 50), unchecked: new Set(merged.map((row) => row.mergeCommit)).size - checked },
  };
}

export function renderBaseline(m: BaselineMetrics): string {
  const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 1000) / 10}%`);
  return [
    `baseline (no model), ${new Date(m.window.since).toISOString().slice(0, 10)}..${new Date(m.window.until).toISOString().slice(0, 10)}${m.window.projectId ? `, project ${m.window.projectId}` : ""}: ${m.accepted} accepted task(s)`,
    `false-done rate ${pct(m.falseDone.rate)} (${m.falseDone.count}: regression, merged revert or -mainfix after acceptance)`,
    `phantom writes ${pct(m.phantomWrites.rate)} (${m.phantomWrites.count} of ${m.phantomWrites.measured} recorded accepted attempt(s) whose merge lacks an expected output${m.phantomWrites.unmeasured ? `; ${m.phantomWrites.unmeasured} without a change record` : ""})`,
    `git loss recoverability ${pct(m.gitLoss.rate)} (${m.gitLoss.recoverable} of ${m.gitLoss.checked} merge commit(s) still in their checkout${m.gitLoss.unchecked ? `; ${m.gitLoss.unchecked} not checked` : ""})`,
  ].join("\n");
}
