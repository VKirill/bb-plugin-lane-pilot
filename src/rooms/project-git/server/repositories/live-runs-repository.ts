import { isAbsolute, relative, resolve } from "node:path";
import { getAttempt, getRun, getRunWriterHost, listLatestBlockedAttemptRefs, listOpenAttempts, taskBasePath, type LanePilotDatabase } from "../../../storage";
import { isLiveDecision } from "../../../writer";

export const within = (child: string, parent: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const overlap = (left: string, right: string): boolean => within(left, right) || within(right, left);

/**
 * Reads the same listOpenAttempts predicate used by writer admission: open states plus retry-eligible attempts with a
 * reconcile cursor. A queued or malformed decision is intentionally treated as a blocker; this callback is called only
 * after projectGit has probed a no-Git folder, so failing closed cannot convert a writer that has not finished binding.
 */
export function overlappingLiveRuns(db: LanePilotDatabase, hostId: string, root: string): string[] {
  const found: string[] = [];
  const consider = (runId: string, path: string | null, decision: unknown): void => {
    if (!path || !overlap(path, root)) return;
    // A live decision is authoritative. A null/invalid legacy decision is unresolved and therefore blocks conversion.
    if (isLiveDecision(decision) || decision === null || decision === undefined || (typeof decision === "object" && decision !== null && "invalidStoredDecision" in decision)) found.push(runId);
  };
  for (const row of listOpenAttempts(db)) {
    const run = getRun(db, row.run_id);
    if (!run || run.closed_at !== null || getRunWriterHost(db, row.run_id) !== hostId || !run.writer_workspace_path) continue;
    const attempt = getAttempt(db, row.id);
    const path = attempt?.workspace_path ?? taskBasePath(db, row.run_id, row.task_id) ?? run.writer_workspace_path;
    consider(row.run_id, path, attempt?.workspace_decision);
  }
  // A blocked live-folder writer can be reopened by owner answer/update, and parked live work retains its files. It is
  // not in listOpenAttempts, so include only the latest blocked attempt of each still-open run/task; old superseded rows
  // and accepted/canceled terminal rows do not pin a folder forever.
  const blocked = listLatestBlockedAttemptRefs(db);
  for (const row of blocked) {
    const run = getRun(db, row.run_id);
    if (!run || getRunWriterHost(db, row.run_id) !== hostId) continue;
    let decision: unknown = null;
    if (row.workspace_decision_json) { try { decision = JSON.parse(row.workspace_decision_json); } catch { decision = { invalidStoredDecision: true }; } }
    consider(row.run_id, row.workspace_path ?? taskBasePath(db, row.run_id, row.task_id) ?? run.writer_workspace_path, decision);
  }
  return [...new Set(found)];
}
