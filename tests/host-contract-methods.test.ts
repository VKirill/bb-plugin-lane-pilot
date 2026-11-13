import { describe, expect, it } from "vitest";
import { hostContract } from "../src/rooms/core/server/plugin-contracts";
import hostEntry from "../host";

// The host RPC wire names are the protocol with machines that run older plugin builds: a rename or a drop
// breaks every one of them. The list is frozen here so a contract or handler rearrangement cannot change it.
const WIRE_METHODS = [
  "anamnesis", "answerPermit", "applyOnboardingPages", "closeBacklogItem",
  "coexistenceInventory", "coexistenceOperation", "connectOpencode", "detect", "discoverClaudeAgents",
  "diskFree", "docsAnchors", "docsFlows", "docsLineCounts",
  "docsWorthinessFacts", "findBrowserQaTarget", "gateAttribute", "gateBisect", "gateRun", "gitCommitDocs", "gitCreateWorktree",
  "gitDocsScope", "gitIntegrate", "gitMergeInfo", "gitOwnershipBase", "gitOwnershipChanges", "gitPrepareWorktree",
  "gitRemoveWorktree", "gitRevertCommits", "gitRevertPaths", "gitSyncWorktree", "gitUndoCheckWrites",
  "gitWorktreeSnapshot", "gitWorktreeState", "inspectCritiqueCoverage", "install", "jobCancel",
  "jobStart", "jobStatus", "listDocsPages", "listFolders", "listPermitTickets", "listWorkflowFiles", "nativeInstall",
  "openCodeLimitProbe", "prepareBbShim", "prepareClaudeGuard", "prepareNativeClaude", "prepareWorkerHome",
  "probeBrowserQaTarget", "readBoundedFile", "readOpenCodeTelemetry", "readUsageWindows", "removeClaudeLaneLeftovers",
    "removeWorkerHome",
  "rollback", "runBrowserQa", "runCommand", "runSandboxedCommand", "runScript", "sandboxCommandLine", "sandboxRelease",
  "session_inventory", "snapshot", "snapshotDryRun", "stabilityDrill", "vpnAddress", "whichPrograms",
  "worktreeJanitor", "writeDocsPages", "writeForgeDraft", "writeForgeEnabled", "writePhaseBook", "writePmSettings", "writeUsageSnapshot",
  "writeWorkflowFile",
];

describe("host RPC wire names", () => {
  it("the contract keeps the same 80 method names", () => {
    expect(Object.keys(hostContract).sort()).toEqual(WIRE_METHODS);
  });

  it("the host entry answers every contract method and nothing else", () => {
    expect(Object.keys(hostEntry.handlers).sort()).toEqual(WIRE_METHODS);
  });
});
