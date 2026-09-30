import { taskV2Schema } from "../../contracts";
import { getTask, listStageReceipts } from "../../database";
import { reconcile } from "../../reconcile";
import type { StageId } from "../../stages/contract";
import type { ProjectLifeTaskSummary } from "../../stages/project-life";
import type { ServerCore } from "../core";

export function createStageChildren(ctx: ServerCore) {
  const { bb, db } = ctx;

  async function reconcileStageChild(projectId:string, runId:string, taskId:string, stageId:StageId, role:string) {
    return reconcile({
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
    }, { lanePilotRunId:runId, lanePilotTaskId:taskId, attemptId:stageId });
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
