// Public API of verification/server: what other rooms import. Everything else in this room is private.
export { room } from "./room";
export { excludeBookkeeping } from "./services/bookkeeping-exclude";
export { gateResolverFor } from "./services/gate-detect";
export { attemptMergeMessage, clearMergeIntent, createMergeIntentRecovery, recordMergeIntent, MERGE_INTENT_PREFIX } from "./services/merge-intent";
export { detectRepoEdits, gitRepoSnapshot, gitRepoStatus, namedByChat, noteEngineWrite, writtenByEngineSince } from "./services/repo-edits";
export type { RepoSnapshot } from "./services/repo-edits";
export { glueReplayCommands } from "../models/replay-checks";
export { IntegrationGateRunner, gateRunVerdict } from "./services/integration-gate";
export { buildMainfixTask } from "../models/mainfix";
export { registerLandingSuiteAction } from "./handlers/landing-suite";
export { handleLandingRed, verifyProofReceiptsCurrent } from "./services/landing-suite";
export { hostGit, proofCurrency } from "./services/proof-currency";
export type { GitRun, ProofCurrencyResult, ProofCurrencyVerdict } from "./services/proof-currency";
export {
  beginVerdictReceipt,
  captureWorkspaceReceiptSnapshot,
  finishVerdictReceipt,
  loadVerdictReceipt,
  persistVerdictReceipt,
  verdictReceiptKvKey,
  verdictReceiptPath,
  verifyAcceptanceReceiptIntegrity,
} from "./services/verdict-receipt";
export type { RepoReceiptSnapshot } from "./services/verdict-receipt";
export {
  PROVIDER_FAILURES_BEFORE_DISABLE,
  PROVIDER_PROBE_AFTER_MS,
  createProviderGate,
  providerListed,
  providerSwitchOn,
  waitProviderEnvironment,
} from "./services/provider-gate";
export type { ProviderHostStatus } from "./services/provider-gate";
