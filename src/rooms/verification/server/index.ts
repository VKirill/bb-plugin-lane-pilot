// Public API of verification/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { excludeBookkeeping } from "./bookkeeping-exclude";
export { gateResolverFor } from "./gate-detect";
export { attemptMergeMessage, clearMergeIntent, createMergeIntentRecovery, recordMergeIntent } from "./merge-intent";
export { detectRepoEdits, gitRepoStatus, namedByChat, noteEngineWrite, writtenByEngineSince } from "./repo-edits";
export { glueReplayCommands } from "./replay-checks"
export { activeRunFor, allGuests, listGuests, noteCheckoutGuest, saveGuests, withGuestsLock } from "./checkout-guests";
export type { Claim, Guest } from "./checkout-guests";
export { WINDOW_USAGE, claimScope, findClaim, forceClearClaim, listClaims, listLiveWindows, projectCheckoutPaths, releaseClaim, runWindowCli, windowCollisions, workFingerprint } from "./window";
export type { LiveWindow, WindowCollision, WorkFingerprint } from "./window";
export { IntegrationGateRunner, gateRunVerdict } from "./integration-gate";
