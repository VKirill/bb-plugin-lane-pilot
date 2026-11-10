// Public API of tasks: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { acceptanceArtifactDir, bbWriterReportMarkdown, buildAcceptanceV2, validateAcceptanceV2 } from "./acceptance-v2";
export { STAGE_IDS, STAGE_PROOF, acceptanceProofGap, isAdvisoryProof, stageReceiptSchema, stageTransition, validateStageReceipt } from "@lane-pilot/contracts";
/** The writer's `sha256` import (writer/server/verify.ts) keeps its name; the hash itself is kit's. */
export { sha256Hex as sha256 } from "@lane-pilot/kit";
export type { StageId, StageProof, StageReceipt, StageState } from "@lane-pilot/contracts";
export type { GateReport } from "./gate-report";
export { RunWriterPool, buildRunExecutionProfile, buildRunPolicy, mapBounded, parseRunPolicy, shouldReconcileAttemptThread, shouldResumeWorktreeHolder, shouldScanLostWorktreeHolder } from "./run-policy";
export { taskStem } from "./task-stem";
export { mapVerificationCwd, retargetTask } from "./verification-cwd";
export { classifyWriterOutput, isMainfixTask, isOutputFolder, isOutputPath, unownedExpectedOutputs } from "./validate-output";
export type { VerifyResult } from "./validate-output";
export { checkoutOwnsOverlap, commonTaskFolder, isTaskBase, ownsFromOuterBase, parseRepoTop, planWithOutsideReads, repoTopCommand, rerootTask } from "./task-base";
export { TRUSTED_TOOLING_PATTERNS, applyTrustedTooling, trustedToolingFor, trustedToolingHint, trustedToolingHits, verificationScriptPaths } from "./trusted-tooling";
export { dependsOnTask } from "./depends";
export { INVARIANT_ITEM, INVARIANT_WORDS } from "./plan-fact";
export { NO_CODE_KINDS, PLAN_FACT_BRIEF_LINE, PLAN_FACT_RULES, blindPlanFact, diffHunksCommand, existsCommand, existsFromCommandOutput, hunksFromCommandOutput, parsePlanFact, planFactOutcome, untouchedCitations } from "./plan-fact";
export type { EvidenceCheck, ItemVerdict, PlanFactCheck, PlanFactFacts, PlanFactTable } from "./plan-fact";
export { BIRTH_GATES, BIRTH_KINDS, CHECK_RECIPES, FACT_KINDS, HOLD_FOREVER, LANE_QUEUES, QUESTION_KINDS, WORKER_ENVELOPE, birthGates, checkRecipe, factKind, isWholeConsent, questionKind, questionsFromFile, secretShaped, laneCap, laneQueueOf, MARKER_BRIEF_LINE, PRIORITIES, STAGE_PRIORITY_RANK, birthFindings, ownerWordFindings, blockingClass, checkProgram, checkScriptEdits, deadLetters, priorityRank, queueOrder, referenceTestEdits, shapeFlags, spendReserve, testOwnedImports, TEST_PATH, writerMarkers } from "./rails";
export { testFitFindings } from "./test-fit";
export type { TestFitFile, TestFitHit } from "./test-fit";
export type { BirthKind, BlockingClass, CheckMeasure, CheckRecipe, FactKind, Priority, QuestionKind, WriterMarkers } from "./rails";
export { OWNER_WORD_WAIT_MS, TASK_WORDS_KEY, landingWordAsked, landingWordGap, ownerSaidNo, ownerWordsMode, ownerWordsOn, readTaskApproach, recordTaskApproach, recordTaskQuestions, recordTaskWord, taskApproachKey, taskQuestionsKey, taskWordKey, waitingAttemptId, type OwnerWordsMode } from "./words";
export type { TaskWord } from "./words";
export { SHARED_PATH_TASKS, batchShapeAdvice } from "./batch-shape";
export type { OpenShape } from "./batch-shape";
export { TASK_SIZE_MIN_SAMPLE, taskSizeOf, taskSizeText } from "./task-size";
export type { TaskSize, TaskSizeMedian } from "./task-size";
export { TOPIC_LOOP, testNames, topicHold, topicLoop, topicLoopMessage } from "./topic-loop";
export type { LoopTask, TopicLoop, TopicWall } from "./topic-loop";
export { CHECK_HISTORY_MIN_RUNS, p95 } from "./check-history";
// The one reading of a check run (pass / product_fail / environment_error / not_run). Also here, not only in ./server: the integration gate (verification/server) imports tasks/server's barrel back through lint-task, a cycle.
export { readCheckRun } from "./server/check-reading";
export type { CheckReading, CheckRun, CheckVerdict } from "./server/check-reading";
export { clipDiff, planFactJudgment } from "./plan-fact-judgment";
export type { PlanFactJevDecision, PlanFactJevInput, PlanFactJevItem } from "./plan-fact-judgment";
