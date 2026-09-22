import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/contracts";
import { detect, snapshotDryRun } from "./src/host-handlers";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { detect, snapshotDryRun },
});
