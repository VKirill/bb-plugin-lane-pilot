import type { ServerCore } from "../../contracts/server";
import { getAttempt, getRun, type LanePilotDatabase } from "../../storage";
import { getAttemptChange, upsertAttemptChange, type ChangedFile } from "../store";

export type RollbackChangeTarget = { runId: string; taskId: string; projectId: string; hostId: string; basePath: string };
export type RollbackChange = { attemptId: string; mergeCommit: string; mergeParent: string | null; changed: ChangedFile[] };
type ChangeOptions = { allowReverted?: boolean };

export function createRollbackChanges(db: LanePilotDatabase, host: ServerCore["host"]) {
  async function changeOf(t: RollbackChangeTarget, attemptId: string, options: ChangeOptions = {}): Promise<RollbackChange | { refused: string }> {
    const actual = getAttempt(db, attemptId), actualRun = actual ? getRun(db, actual.run_id) : undefined;
    const recorded = getAttemptChange(db, attemptId);
    const refusal = `attempt ${attemptId} has mismatched accepted-change provenance; the rollback was not sent to the host`;
    if (!actual || actual.state !== "accepted" || !actualRun || actualRun.project_id !== t.projectId || actual.run_id !== t.runId || actual.task_id !== t.taskId
      || (recorded && (recorded.runId !== t.runId || recorded.taskId !== t.taskId))) return { refused: refusal };
    if (recorded?.mergeCommit) {
      if (recorded.outcome !== "merged" && !(options.allowReverted && recorded.outcome === "reverted")) return { refused: refusal };
      return { attemptId, mergeCommit: recorded.mergeCommit, mergeParent: recorded.mergeParent, changed: recorded.changed };
    }
    const found = await host.call("gitMergeInfo", { requestedHostId: t.hostId, basePath: t.basePath, attemptId }, { hostId: t.hostId, timeoutMs: 60_000 });
    if (found.status !== "found" || !found.commit) {
      return { refused: found.status === "failed" ? `git could not look for the merge of attempt ${attemptId} in ${t.basePath}: ${found.reason ?? "unknown"}` : `attempt ${attemptId} left no merge commit in ${t.basePath} (it was accepted in place, in a folder without git, or its work was already in main)` };
    }
    if (!found.inMain) return { refused: `the merge ${found.commit.slice(0, 12)} of attempt ${attemptId} is no longer in the history of ${t.basePath} (history was rewritten)` };
    upsertAttemptChange(db, { attemptId, runId: t.runId, taskId: t.taskId }, { outcome: "merged", mergeCommit: found.commit, mergeParent: found.base, changed: found.changed });
    return { attemptId, mergeCommit: found.commit, mergeParent: found.base, changed: found.changed };
  }

  return { changeOf };
}
