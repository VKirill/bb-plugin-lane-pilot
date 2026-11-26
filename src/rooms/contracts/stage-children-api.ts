import type { StageId } from "@lane-pilot/contracts";
import type { ReconcileResult } from "./stability-api";

/** The stage-child reconciler, implemented by src/rooms/qa (createStageChildren) and handed through the services bag. */
export interface StageChildrenPort {
  reconcileStageChild(projectId: string, runId: string, taskId: string, stageId: StageId, role: string): Promise<ReconcileResult>;
}
