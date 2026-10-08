// Public API of runs: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { acceptanceStats } from "./acceptance-stats";
export { aggregateRun } from "./aggregation";
export { DISPATCH_IDEMPOTENT_WINDOW_MS, DISPATCH_STAGES_PENDING, EXTERNAL_OPS, EXTERNAL_OPS_WARNING, S8_RELATIVE_PATHS, TARGET_SHA, UPSTREAM_REPO, cliReceiptAttemptKey, cliReceiptRunKey } from "./constants";
export { judgedFailureClass } from "./failure-class-model";
export { ENVIRONMENT_REASON, FREE_CLASSES, FREE_RETRY_LIMIT, NO_ANSWER_REASON, PARKED_CLASSES, REPLAY_CHECK_FAILED, SESSION_MAX_MS, SESSION_MAX_TURNS, WRITER_SILENT_REASON, failureClass, failureFingerprint, isEnvironmentCheckFailure, isWaitingSecret, isWriterSilent, liveFolderLockNote, nextStep, repeatedFailureReason, taskFamily, turnFailureKey } from "./failure-class";
export type { FailureClass } from "./failure-class";
export { IllegalTransitionError, MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE, isLegalMove } from "./state-machine";
export type { AttemptState } from "./state-machine";
