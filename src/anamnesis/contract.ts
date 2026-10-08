import { z } from "zod";
import { anamnesisRequestSchema } from "./ops";

/**
 * The two entries anamnesis adds to the contracts, kept here so `src/contracts.ts` takes one line each:
 *  - the host method `anamnesis` (runs on the owner's machine, where the store is);
 *  - the RPC `anamnesis` (the hub; the CLI `bb lane-pilot anamnesis` and the later tab call it).
 * No agent tool is added anywhere: the PM's tool list is full.
 */
export const anamnesisHostMethods = {
  anamnesis: {
    input: z.object({ requestedHostId: z.string().min(1), request: anamnesisRequestSchema }).strict(),
    output: z.object({ hostId: z.string(), response: z.unknown() }).strict(),
  },
};

/** What the hub itself does besides forwarding a store request. */
export const hubOps = {
  host: z.object({ op: z.literal("host"), hostId: z.string().min(1).optional() }).strict(),
} as const;

export const anamnesisRpcRequestSchema = z.union([anamnesisRequestSchema, hubOps.host]);
export type AnamnesisRpcRequest = z.infer<typeof anamnesisRpcRequestSchema>;

export const anamnesisRpcMethods = {
  anamnesis: {
    input: z.object({ request: anamnesisRpcRequestSchema }).strict(),
    output: z.object({ result: z.unknown() }).strict(),
  },
};
