import type { BaselineApi } from "../../baseline/server/baseline";
import type { MoneyApi } from "../../money/server";
import type { OwnerPresenceApi } from "../../owner-presence/server/presence";
import type { RollbackApi } from "../../rollback/server/rollback";
import type { RuleScanApi } from "../../self-repair/server/rule-scan";
import type { ReconcileApi } from "../../stability/server/reconcile";
import type { StabilityPort } from "../../contracts";
import type { WallApi } from "../../wall/service";
import type { WriterFinishApi } from "./finish";
import type { WriterSpawnApi } from "./spawn";
import type { WriterStateApi } from "./state";
import type { WriterVerifyApi } from "./verify";
import type { HarnessApi } from "../../harness/server/harness";
import type { WorkflowEngineApi } from "../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  baseline: BaselineApi;
  concurrencyLimit: WriterStateApi["concurrencyLimit"];
  finishWriterAttempt: WriterFinishApi["finishWriterAttempt"];
  harness: HarnessApi;
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  money: MoneyApi;
  ownerPresence: OwnerPresenceApi;
  providerBreaker: WriterStateApi["providerBreaker"];
  providerRetry: WriterStateApi["providerRetry"];
  providerUsage: WriterStateApi["providerUsage"];
  reconcileAttemptThread: ReconcileApi["reconcileAttemptThread"];
  restoreLiveFolder: WriterSpawnApi["restoreLiveFolder"];
  rollback: RollbackApi;
  ruleScan: RuleScanApi;
  runBudgetFor: WriterStateApi["runBudgetFor"];
  runVerification: WriterVerifyApi["runVerification"];
  runWriterPool: WriterStateApi["runWriterPool"];
  spawnWriterAttempt: WriterSpawnApi["spawnWriterAttempt"];
  stability: StabilityPort;
  startAfterAcceptance: WorkflowEngineApi["startAfterAcceptance"];
  wall: WallApi;
  workspaceDirt: WriterSpawnApi["workspaceDirt"];
}
