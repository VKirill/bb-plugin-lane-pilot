import { defineRpcContract } from "@get-bb/plugin-sdk";
import { hostMethods, rpcMethods } from "../../contracts";
import { anamnesisHostMethods, anamnesisRpcMethods } from "../../anamnesis/contract";
import { scheduleRpcContract } from "../../schedule/contract";

// The plugin's wire contracts, assembled inside the composition root (core): the contracts room holds only
// the base slices in rpcMethods/hostMethods, the schedule and anamnesis slices stay with their domains, and
// this file spreads them in the same order the room used to, so both contracts keep their exact shape.
// server.ts re-exports rpcContract, host.ts registers hostContract, core.ts hands hostContract to the host client.
export const rpcContract = defineRpcContract({
  ...scheduleRpcContract,
  ...rpcMethods,
  ...anamnesisRpcMethods,
});

export const hostContract = defineRpcContract({
  ...hostMethods,
  ...anamnesisHostMethods,
});
