import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/contracts";
import {
  connectOpencode,
  classifyPlan,
  coexistenceInventory,
  coexistenceOperation,
  detect,
  importConfig,
  install,
  rollback,
  runCli,
  runCommand,
  snapshot,
  snapshotDryRun,
  writePmSettings,
} from "./src/host-handlers";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    detect, coexistenceInventory, coexistenceOperation, snapshotDryRun, snapshot, install, rollback, importConfig, connectOpencode, classifyPlan,
    runCli, runCommand, writePmSettings,
  },
});
