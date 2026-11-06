import { defineRpcContract } from "@get-bb/plugin-sdk";
import { anamnesisHostMethods } from "../anamnesis";
import { desktopHostMethods } from "./host/desktop";
import { docsHostMethods } from "./host/docs";
import { execHostMethods } from "./host/exec";
import { fileHostMethods } from "./host/files";
import { gitHostMethods } from "./host/git";
import { jobHostMethods } from "./host/jobs";
import { judgeHostMethods } from "./host/judges";
import { machineHostMethods } from "./host/machine";
import { stackHostMethods } from "./host/stack";

// The wire names are the protocol with hosts running older builds: every method lives in the domain file
// under contracts/host/ that changes with it, and tests/host-contract-methods.test.ts pins the full list.
export const hostContract = defineRpcContract({
  ...stackHostMethods,
  ...gitHostMethods,
  ...docsHostMethods,
  ...fileHostMethods,
  ...machineHostMethods,
  ...jobHostMethods,
  ...judgeHostMethods,
  ...execHostMethods,
  ...desktopHostMethods,
  ...anamnesisHostMethods,
});
