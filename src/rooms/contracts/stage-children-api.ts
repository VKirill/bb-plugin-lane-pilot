import type { StageId } from "@lane-pilot/contracts";
import type { ReconcileResult } from "./stability-api";
import type { ProjectLifeTaskSummary } from "./project-life";

/** The stage-child reconciler, implemented by src/rooms/qa (createStageChildren) and handed through the services bag. */
export interface StageChildrenPort {
  reconcileStageChild(projectId:string, runId:string, taskId:string, stageId:StageId, role:string): Promise<ReconcileResult>;
  reconcileDocsChild(projectId:string, runId:string, taskId:string): Promise<ReconcileResult>;
  reconcileProjectLifeChild(projectId:string, runId:string, taskId:string): Promise<ReconcileResult>;
  projectLifeTaskSummary(runId:string, taskId:string): ProjectLifeTaskSummary;
}
