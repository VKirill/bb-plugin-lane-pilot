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
export { NO_CODE_KINDS, PLAN_FACT_BRIEF_LINE, blindPlanFact, diffHunksCommand, existsCommand, existsFromCommandOutput, hunksFromCommandOutput, parsePlanFact, planFactOutcome, untouchedCitations } from "./plan-fact";
export type { EvidenceCheck, ItemVerdict, PlanFactCheck, PlanFactFacts, PlanFactTable } from "./plan-fact";
export { BIRTH_KINDS, CHECK_RECIPES, FACT_KINDS, HOLD_FOREVER, LANE_QUEUES, QUESTION_KINDS, WORKER_ENVELOPE, checkRecipe, factKind, isWholeConsent, questionKind, questionsFromFile, secretShaped, laneCap, laneQueueOf, MARKER_BRIEF_LINE, PRIORITIES, birthFindings, ownerWordFindings, blockingClass, checkProgram, deadLetters, priorityRank, queueOrder, referenceTestEdits, spendReserve, writerMarkers } from "./rails";
export type { BirthKind, BlockingClass, CheckMeasure, CheckRecipe, FactKind, Priority, QuestionKind, WriterMarkers } from "./rails";
export { TASK_WORDS_KEY, landingWordGap, recordTaskWord, taskWordKey } from "./words";
export type { TaskWord } from "./words";
export { SHARED_PATH_TASKS, batchShapeAdvice } from "./batch-shape";
export type { OpenShape } from "./batch-shape";
export { TOPIC_LOOP, testNames, topicLoop, topicLoopMessage } from "./topic-loop";
export type { LoopTask, TopicLoop } from "./topic-loop";
export { CHECK_HISTORY_MIN_RUNS, p95 } from "./check-history";
