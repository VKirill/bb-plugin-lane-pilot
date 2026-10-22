// Public API of tasks: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { acceptanceArtifactDir, bbWriterReportMarkdown, buildAcceptanceV2, validateAcceptanceV2 } from "./acceptance-v2";
export { STAGE_IDS, STAGE_PROOF, acceptanceProofGap, isAdvisoryProof, sha256, stageReceiptSchema, stageTransition, validateStageReceipt } from "@lane-pilot/contracts";
export type { StageId, StageProof, StageReceipt, StageState } from "@lane-pilot/contracts";
export type { GateReport } from "./gate-report";
export { RunWriterPool, buildRunExecutionProfile, buildRunPolicy, mapBounded, parseRunPolicy, shouldReconcileAttemptThread, shouldResumeWorktreeHolder, shouldScanLostWorktreeHolder } from "./run-policy";
export { taskStem } from "./task-stem";
export { mapVerificationCwd, retargetTask } from "./verification-cwd";
export { classifyWriterOutput, isMainfixTask, isOutputPath, unownedExpectedOutputs } from "./validate-output";
export type { VerifyResult } from "./validate-output";
export { commonTaskFolder, isTaskBase, ownsFromOuterBase, parseRepoTop, planWithOutsideReads, repoTopCommand, rerootTask } from "./task-base";
export { TRUSTED_TOOLING_PATTERNS, applyTrustedTooling, trustedToolingFor, trustedToolingHint, trustedToolingHits, verificationScriptPaths } from "./trusted-tooling";
