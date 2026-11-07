// Public API of errands (the «Errands» page and the episode facts): the read model over the errand runs, the episode
// recorder the workflow engine calls when a run ends, and the phase-B enrichment the hourly sweep writes. The RPC is
// behind ./server, the screen behind ./ui.
export { ERRAND_KINDS_WITH_NONE, errandStem, errandTitle, routeConfidence, kindsOverview, listErrands, type ErrandKindOrNone, type ErrandRow, type ErrandSource, type KindSummary } from "./logic";
export { ERRAND_EPISODE_ENRICH_COLUMNS, errandSpawnOf, listEpisodes, pendingErrandEpisode, recordErrandEpisode, type EpisodeDeps, type EpisodeRow } from "./episodes";
export { EPISODE_ENRICH_BACKOFF_MS, EPISODE_SWEEP_LIMIT, codeFailureClass, enrichEpisode, episodeSkills, episodesBackfill, parseEpisodeAnswer, pendingEpisodes, sweepErrandEpisodes, type BackfillResult, type EpisodeAnswer, type EpisodeEnrichDeps, type EpisodeSkillUse, type PendingEpisode, type SweepResult } from "./episode-enrich";
export { ERRAND_FAILURE_CLASSES, ERRAND_FAILURE_ID, errandFailureJudgment, type ErrandFailureClass, type ErrandFailureDecision, type ErrandFailureInput } from "./failure-judgment";
export { diagnosisLines, errandsDiagnosis, errandsDiagnosisMorningLine, type DiagnosisKindCost, type DiagnosisShare, type ErrandsDiagnosis } from "./diagnosis";
export { PROCESS_KEY_JUDGMENT_ID, chooseProcessKey, nearestKeys, pairwiseF1, processKeyJudgment, type KnownProcessKey, type NearProcessKey, type ProcessKeyDecision, type ProcessKeyInput, type ProcessKeyPick } from "./process-key";
export { ERRANDS_USAGE, processKeyEval, runErrandsCli, wordJudge, type ProcessKeyEvalResult } from "./process-key-eval";
