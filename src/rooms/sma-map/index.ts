// Public API of sma-map: the SMA product map node by node, what Lane Pilot has for each node and the proof in the code.
export { SMA_MAP_USAGE, defaultProofRoots, renderSmaMap, runSmaLiveCli, runSmaMapCli } from "./cli";
export { SMA_LIVE, readSmaLive, renderSmaLive, smaGroups } from "./live";
export type { LiveRow, LiveSource } from "./live";
export { brokenProof, isChecked, isDone, smaCheckedPercent, smaCounts, smaDonePercent, smaHoles, smaRows, smaStateCounts, unjudgedProof } from "./model";
export type { ProofRoots, SmaCounts, SmaRow, SmaEvidence, SmaStateCounts } from "./model";
export { smaEvidence } from "./model";
export { SMA_CARDS, SMA_LINKS, SMA_MAP_SHA, SMA_NODES, SMA_REGIONS } from "./graph";
export type { SmaCard, SmaKind, SmaLinkKind, SmaNode } from "./graph";
export { SMA_CONTRACT_TESTS } from "./contracts";
export { SMA_ENTRIES } from "./entries";
export type { SmaEntry, SmaStatus } from "./entries";
