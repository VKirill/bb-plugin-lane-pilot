import { taskV2Schema } from "../../contracts";
import { getTask, listStageReceipts } from "../../storage";
import { reconcile } from "../../stability";
import type { ReconcileResult } from "../../stability";
import type { StageId } from "../../tasks";
import type { ProjectLifeTaskSummary } from "../../project-life";
import { clearSpawnMarker, findThreadsByMetadata } from "../../core/server";
import type { ServerCore } from "../../core/server";

export function createStageChildren(ctx: ServerCore) {
  const { bb, db } = ctx;

  async function reconcileStageChild(projectId:string, runId:string, taskId:string, stageId:StageId, role:string): Promise<ReconcileResult> {
    // Only a stage that claimed its spawn can have lost a child. Scanning for every fresh stage read the metadata of
    // every thread of the project and, once SelfyStudio passed 1000, returned page_cap for 42 memory stages that then
    // stayed running for good (live 2026-10-04).
    const receipt = listStageReceipts(db, runId, taskId).find((row) => row.stageId === stageId);
    const result = receipt?.result && typeof receipt.result === "object" ? receipt.result as Record<string, unknown> : {};
    if (result.spawnAttempted !== true) return { kind:"not_found" };
    const found = await reconcile({
      list: async ({ limit, offset }) => (await bb.sdk.threads.list({
        projectId, originPluginId:"lane-pilot", includeHidden:true, limit, offset,
      })).map((thread) => ({ id:thread.id })),
      metadata: async (threadId) => {
        const meta = await bb.sdk.threads.getPluginMetadata({ threadId }) as Record<string, unknown>;
        if (meta.role === role && meta.stageId === stageId
          && meta.lanePilotRunId === runId && meta.lanePilotTaskId === taskId) {
          return { ...meta, attemptId:stageId };
        }
        return meta;
      },
      find: (match) => findThreadsByMetadata(bb, match, projectId),
    }, { lanePilotRunId:runId, lanePilotTaskId:taskId, attemptId:stageId },
    { match:{ role, stageId, lanePilotRunId:runId, lanePilotTaskId:taskId } });
    // Adopted instead of answered: the next spawn of this stage must not get this thread back (thread-keys.ts).
    if (found.kind === "found") await clearSpawnMarker(bb, { role, stageId, lanePilotRunId:runId, lanePilotTaskId:taskId });
    return found;
  }

  async function reconcileDocsChild(projectId:string, runId:string, taskId:string) {
    return reconcileStageChild(projectId, runId, taskId, "docs-maintenance", "docs-maintainer");
  }

  async function reconcileProjectLifeChild(projectId:string, runId:string, taskId:string) {
    return reconcileStageChild(projectId, runId, taskId, "project-life", "project-life-maintainer");
  }

  function projectLifeTaskSummary(runId:string, taskId:string): ProjectLifeTaskSummary {
    const row = getTask(db, taskId);
    const parsed = row ? taskV2Schema.safeParse(row.contract) : null;
    const accepted = listStageReceipts(db, runId, taskId).find((item) => item.stageId === "acceptance-receipt");
    const report = accepted?.result && typeof accepted.result === "object" ? (accepted.result as Record<string, unknown>).report : undefined;
    return {
      id:taskId,
      title:parsed?.success ? parsed.data.title : taskId,
      objective:parsed?.success ? parsed.data.objective : "",
      acceptanceSummary:typeof report === "string" ? report.slice(0, 2000) : "",
    };
  }

  return { reconcileStageChild, reconcileDocsChild, reconcileProjectLifeChild, projectLifeTaskSummary };
}
