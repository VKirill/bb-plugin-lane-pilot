// Public API of rollback/server: what other rooms import. Everything else in this room is private.
export { room } from "./room";
export { ROLLBACK_USAGE, runRollbackCli } from "./handlers/rollback-cli";
export { rollbackRpc } from "./handlers/rollback-rpc";
export { createRollback, type RollbackApi } from "./services/rollback";
export { createRollbackChanges } from "./services/changes";
export { recoveryState } from "./services/recovery";
export { medianTaskSize } from "./services/task-size";
export {
  acceptedChangeProofRows,
  attemptChangeJson,
  claimLandingSuite,
  dependencyChangeProofRows,
  getAttemptChange,
  listAttemptChanges,
  listLandingSuitePending,
  mergedAttemptChanges,
  mergeShaOf,
  noteLandingSuite,
  upsertAttemptChange,
} from "./repositories/attempt-change-repository";
export { appendTaskReceipt, listTaskReceipts, settleRevert } from "./repositories/receipt-repository";
export { clearRevertIntent, readRevertIntents, writeRevertIntent } from "./repositories/revert-intent-repository";
export {
  REVERT_INTENT_PREFIX,
  revertIntentKey,
  revertOpId,
  type AttemptChange,
  type ChangedFile,
  type EffectState,
  type LandingPending,
  type LandingSuite,
  type RecoveryState,
  type RevertIntent,
  type RevertIntentKv,
  type RevertIntentRead,
  type RollbackItem,
  type RollbackResult,
  type RollbackTarget,
  type TaskReceipt,
  type TaskReceiptKind,
  type TaskReceiptState,
  type WorktreeRecord,
} from "../models";
