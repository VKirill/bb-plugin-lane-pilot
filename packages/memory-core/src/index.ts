export {
  MEMORY_AUDIENCES,
  MEMORY_PERSONAL_BOTS,
  MEMORY_SEARCH_ENGINES,
  MAX_BUDGET,
  MEMORY_SETTING_KEYS,
  REVIEWER_CONCEPTS,
  parseMemorySettings,
  type MemoryAudience,
  type MemoryCandidate,
  type MemoryKind,
  type MemoryRecord,
  type MemoryStatus,
  type MemoryTrust,
  type MemorySearchEngine,
  type MemorySettings,
} from "./settings";
export { estimateTokens, memoryEntrySupported, memoryRecordId, parseMemoryCandidates, memoryEntrySalience, memoryClaimIssue } from "./candidates";
export { isSharedScope, resolveProjectKind, sharedScope, UNASSIGNED_SCOPE, type ProjectKind } from "./sections";
export { ANSWER_GATE, weakAnswer, gateScore, answerProbability, DEFAULT_RELEVANCE_FLOOR, DENSE_PREFILTER, NOTHING_RELEVANT, clearsFloor, floorThreshold, recordRelevance, relevantRecords, wordFrequencies, questionWords, pathAnchorsOf, type RelevanceFloor, type RecordRelevance } from "./floor";
export { buildContextPack, memoryCandidates, shadowPackCompare, type ContextPack, type PackCandidate, type PackSource } from "./context-pack";
export { ROLE_CONTEXT_BUDGET, explainMemory, isHistoryQuery, isoDay, memoryContext, memoryContextLine, memoryHeadLine, type PackOptions, memoryMaintenanceBrief, memoryMaintenancePrompt, memoryMaintainerTools, roleContextBudget } from "./context";
export { fileFingerprint, filesDrifted, pathsNamed } from "./fingerprint";
export { MEMORY_SCHEMA, addToIndexes, coreShelf, deleteMemoryRecord, dropMemoryIndexes, firstUnusedCoreRecordId, trigramReady, listActiveMemoryRows, listMemory, hideRecordsOfFile, memoryConceptsJson, memoryFillRows, memoryHiddenRows, memoryVisibilitySql, scopeValuesFor, projectUsesSections, searchMemoryAllSections, searchMemoryRecords, wordCandidates, BRIDGE_TOP, withHistory, storeMemoryRecords, storeMemoryRecordsKeepingOverflow, coldMemoryRows, reactivateColdMemory, recordMemoryPromotion, listIdlePromotions, expireIdleMemory, recordMemoryMiss, countColdMemories, countMemoryPromotions, listMemoryMisses, insertMemoryRecord, countActiveMemoryByContent, memoryTrustOf, listMemoryScopeRows, listActiveNoteIds, countActiveNotes, otherMemoryProjectId, listMemoryIdsByOrigin, listMemoryByOrigin, recordMemoryProbe, latestMemoryProbeRows, pruneMemoryProbeBefore, activeMemoryDigestRows, memoryRecordExists, type MemoryDatabase, type SearchOptions, type StoreMemoryInput, type StoreMemoryResult, rebuildMemoryIndexes, memoryIndexStatus, memoryWithoutTrace, countActiveMemory, memoryTokenStats, eraseLeftovers, listRemindedMisses } from "./store";
export { LINT_CHECKS, lintMemory, reviewMemory, type LintCheck, type LintContext, type LintFinding, type LintTier, type ReviewProposal } from "./lint";
export { memoryStem, memoryTokens } from "./terms";
export { EMBED_DIM, EMBED_MODEL, CHUNK_CHARS, DOC_CHARS, chunkDocumentText, contentChunks, denseRank, documentText, pendingChunks, pendingVectors, storeChunkVectors, queryText, queryVectorFor, rememberQueryVector, storeVectors, vectorsReady } from "./vectors";
export { NOTE_IDLE_MS, OBSERVED_QUARANTINE_MS, hideRecord, listMemoryReceipts, memoryUsefulness, noteRefutedByCheck, recordCriticUse, recordMemoryAccepted, recordMemoryMixed, recordMemoryReceipt, memoryJudgeStats, type JudgeStats, retireStaleCuratorClaims, sameSubject, type ExpiredReason, type MemoryReceiptRow } from "./lifecycle";
export { audienceForSensitivity, exportedFileName, laneMemoryFileToCandidate, parseLaneMemoryFile, renderLaneMemoryFile, sensitivityForAudience, type LaneMemoryFile } from "./files";
export { findConflicts, conflictId, disagreement, type Conflict, type ConflictKind, type ConflictNote } from "./conflicts";
export { conflictTableReady, getConflict, heldClause, holdConflict, listConflicts, markSettled, memoryConflictMigrations, setDeferral, type ConflictResolution, type ConflictRow } from "./conflict-store";
export { HEAVY_NOTE_TOKENS, applyShorter, compressibleRow, heavyNoteRows, proposeShorter, resolveCompressible, shortenText, undoShorter, type CompressibleRow } from "./compress";
export { JUDGE_DEFAULTS, JUDGE_FALLBACK_TOP, JUDGE_MASK, JUDGE_NOTE_CHARS, JUDGE_SYSTEM, judgeUserPrompt, maskSecretsForJudge, parseJudgeReply, readJudgeReply, permutationOf, rerankUserPrompt, RERANK_SYSTEM, TRANSLATE_SYSTEM, translateUserPrompt, parseKeywords, type ReadReply, queryHash, shuffledBy, type JudgeFallback, type JudgeReceipt } from "./judge";

export { DUP_CONTAINMENT, DUP_COSINE, addOrigin, dedupeProject, duplicatePairs, duplicateWords, factsAgree, nearDuplicate, duplicateDoor, withoutShadowedDuplicates, storedVectors, textRelation, type DedupeResult, type DuplicateHit, type DuplicatePair } from "./duplicates";
export { DOOR_LOCKS, DOOR_MIN_WEIGHT, doorOpens, forgetLockTerms, lockQueryText, lockTermsFor, rememberLockTerms, type DoorLock } from "./door-lock";
export { crossesLanguage, cyrillicShare, languageOf, type TextLanguage } from "./language";
