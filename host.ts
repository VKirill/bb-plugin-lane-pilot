import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/contracts";
import {
  connectOpencode,
  classifyPlan,
  councilJudge,
  browserGoal,
  docsWorthinessFacts,
  coexistenceInventory,
  coexistenceOperation,
  gitOwnershipBase,
  gitOwnershipChanges,
  gitIntegrate,
  gitPrepareWorktree,
  gitCreateWorktree,
  gitRemoveWorktree,
  applyOnboardingPages,
  writeDocsPages,
  gitDocsScope,
  docsLineCounts,
  docsAnchors,
  docsVerifyCitations,
  docsFlows,
  docsDepth,
  docsStalenessHandler,
  gitCommitDocs,
  gitRevertPaths,
  listDocsPages,
  detect,
  importConfig,
  inspectCritiqueCoverage,
  install,
  readBoundedFile,
  readOpenCodeTelemetry,
  rollback,
  runCli,
  runCommand,
  runSandboxedCommand,
  sandboxCommandLine,
  sandboxRelease,
  vpnAddress,
  runBrowserQa,
  probeBrowserQaTarget,
  snapshot,
  snapshotDryRun,
  writePmSettings,
  discoverClaudeAgentsHost,
  prepareNativeClaudeHost,
} from "./src/host-handlers";
import { sessionInventory } from "./src/session-inventory";
import { nativeInstallHost } from "./src/native-install-host";
import { provideJevKey } from "./src/verification/docs-jev";

/** Takes the Env Catalog key the server attached to a Jev call before the handler runs. */
const withJevKey = <I extends { jevApiKey?: string }, C, O>(handler: (input: I, context: C) => O | Promise<O>) => async (input: I, context: C) => {
  provideJevKey(input.jevApiKey);
  return await handler(input, context);
};

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    nativeInstall: nativeInstallHost,
    detect, coexistenceInventory, coexistenceOperation, gitOwnershipBase, gitOwnershipChanges, gitDocsScope, docsWorthinessFacts, docsLineCounts, gitCommitDocs, gitRevertPaths, docsAnchors:withJevKey(docsAnchors), docsFlows:withJevKey(docsFlows), docsDepth:withJevKey(docsDepth), docsVerifyCitations:withJevKey(docsVerifyCitations), docsStaleness:withJevKey(docsStalenessHandler), gitIntegrate, gitPrepareWorktree, gitCreateWorktree, gitRemoveWorktree, readOpenCodeTelemetry, readBoundedFile, listDocsPages, applyOnboardingPages, writeDocsPages, snapshotDryRun, snapshot, install, rollback, importConfig, connectOpencode, classifyPlan:withJevKey(classifyPlan), inspectCritiqueCoverage,
    councilJudge:withJevKey(councilJudge), browserGoal, runCli, runCommand, runSandboxedCommand, sandboxCommandLine, sandboxRelease, vpnAddress, runBrowserQa, probeBrowserQaTarget, writePmSettings, session_inventory: sessionInventory,
    discoverClaudeAgents: discoverClaudeAgentsHost, prepareNativeClaude: prepareNativeClaudeHost,
  },
});
