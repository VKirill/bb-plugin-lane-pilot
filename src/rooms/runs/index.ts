// Public API of runs: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { acceptanceStats } from "./acceptance-stats";
export { aggregateRun } from "./aggregation";
export { beginChecks, checksInFlight, checksMoved } from "./checks-in-flight";
export { DISPATCH_IDEMPOTENT_WINDOW_MS, DISPATCH_STAGES_PENDING, EXTERNAL_OPS, EXTERNAL_OPS_WARNING, S8_RELATIVE_PATHS, TARGET_SHA, UPSTREAM_REPO, cliReceiptAttemptKey, cliReceiptRunKey } from "./constants";
export { judgedFailureClass } from "./failure-class-model";
export { ENVIRONMENT_REASON, FREE_CLASSES, FREE_RETRY_LIMIT, NO_ANSWER_REASON, PARKED_CLASSES, REPLAY_CHECK_FAILED, SESSION_MAX_MS, SESSION_MAX_TURNS, VERIFICATION_TIMEOUT_RETRIES, WRITER_SILENT_REASON, failureClass, failureFingerprint, failureSide, isEnvironmentCheckFailure, isOwnerDecision, isPreStartStop, isWaitingSecret, isWriterSilent, liveFolderLockNote, nextStep, repeatedFailureReason, taskFamily, turnFailureKey, verificationTimeoutOverBudget } from "./failure-class";
export type { FailureClass, FailureSide } from "./failure-class";
export { IllegalTransitionError, MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE, TRANSITION_TABLE, isLegalMove } from "./state-machine";
export type { AttemptState } from "./state-machine";
export { isKnownReason, unknownReasons } from "./unknown-codes";
export { failureClassJudgment } from "./failure-class-judgment";
export type { FailureClassDecision, FailureClassInput } from "./failure-class-judgment";
