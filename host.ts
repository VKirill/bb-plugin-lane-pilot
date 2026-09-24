import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/contracts";
import {
  connectOpencode,
  classifyPlan,
  coexistenceInventory,
  coexistenceOperation,
  gitOwnershipBase,
  gitOwnershipChanges,
  applyOnboardingPages,
  listDocsPages,
  detect,
  importConfig,
  inspectCritiqueCoverage,
  install,
  readOpenCodeTelemetry,
  rollback,
  runCli,
  runCommand,
  runSandboxedCommand,
  runBrowserQa,
  probeBrowserQaTarget,
  snapshot,
  snapshotDryRun,
  writePmSettings,
} from "./src/host-handlers";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    detect, coexistenceInventory, coexistenceOperation, gitOwnershipBase, gitOwnershipChanges, readOpenCodeTelemetry, listDocsPages, applyOnboardingPages, snapshotDryRun, snapshot, install, rollback, importConfig, connectOpencode, classifyPlan, inspectCritiqueCoverage,
    runCli, runCommand, runSandboxedCommand, runBrowserQa, probeBrowserQaTarget, writePmSettings,
  },
});
