// Public API of errands (the «Errands» page and the episode facts): the read model over the errand runs and the
// episode recorder the workflow engine calls when a run ends. The RPC is behind ./server, the screen behind ./ui.
export { ERRAND_KINDS_WITH_NONE, errandOutcome, errandTitle, kindsOverview, listErrands, type ErrandKindOrNone, type ErrandOutcome, type ErrandVerifiedOutcome, type ErrandRow, type ErrandSource, type KindSummary } from "./logic";
export { ERRAND_EPISODE_EXTRACTOR_VERSION, ERRAND_EPISODE_TABLE, ERRAND_EPISODE_TRACE_EVENTS, errandSpawnOf, listEpisodes, pendingErrandEpisode, recordErrandEpisode, type EpisodeDeps, type EpisodeRow } from "./episodes";
export { PROCESS_KEY_JUDGMENT_ID, chooseProcessKey, nearestKeys, pairwiseF1, processKeyJudgment, type KnownProcessKey, type NearProcessKey, type ProcessKeyDecision, type ProcessKeyInput, type ProcessKeyPick } from "./process-key";
export { ERRANDS_USAGE, processKeyEval, runErrandsCli, wordJudge, type ProcessKeyEvalResult } from "./process-key-eval";
