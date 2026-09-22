import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/contracts";
import {
  connectOpencode,
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
    detect, snapshotDryRun, snapshot, install, rollback, importConfig, connectOpencode,
    runCli, runCommand, writePmSettings,
  },
});
