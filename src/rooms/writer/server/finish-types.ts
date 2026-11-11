import type { StageHelperSettings } from "../../platform/server";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import type { TaskWordPort, LeadRoadApi } from "../../contracts";
import type { RollbackApi } from "../../rollback/server/rollback";
import type { WriterSpawnApi } from "./spawn";
import type { WriterStateApi } from "./state";
import type { WriterVerifyApi } from "./verify";
import type { BaselineApi } from "../../baseline/server/baseline";
import type { PromotionServiceApi } from "../../rule-forms/promotion-service";
import type { WriterDispatchApi } from "./dispatch";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
  stageHelperSettings: StageHelperSettings;
  baseline: BaselineApi;
  dispatchWriter: WriterDispatchApi["dispatchWriter"];
  persistWriterAcceptance: WriterVerifyApi["persistWriterAcceptance"];
  promotions: PromotionServiceApi;
  providerBreaker: WriterStateApi["providerBreaker"];
  rollback: RollbackApi;
  runBudgetFor: WriterStateApi["runBudgetFor"];
  runVerification: WriterVerifyApi["runVerification"];
  validateWriterResult: WriterVerifyApi["validateWriterResult"];
  workspaceDirt: WriterSpawnApi["workspaceDirt"];
  taskWords: TaskWordPort;
  leadRoad: LeadRoadApi;
}

export type FinishInput = {
  projectId:string; config:PrototypeConfig; task:TaskV2;
  runId:string; taskId:string; attemptId:string; pmThreadId:string; writerThreadId:string;
  dirtBefore:import("../cli-outcome").DirtSnapshot[];
  emergencyFallback?:{reason:string;primaryAttemptId:string;providerId:string;model:string};
  /** Gives the writer's pool slot back early: the wait for the owner's word needs no writer seat (Gemini F-008.2). */
  releaseSlot?:()=>void;
};
