import { z } from "zod";
import { configSchema } from "./hub";
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
  /** Reads the settings of anamnesis kept on the hub, or changes some of them (the extraction switch, the Jev ceiling, the Telegram channels). */
  config: z.object({ op: z.literal("config"), set: configSchema.partial().omit({ hostId: true, authors: true, roots: true }).optional() }).strict(),
  /** Runs the daily pass now (the Anamnesis tab's «run now»); it answers with the pass report. */
  pass: z.object({ op: z.literal("pass") }).strict(),
} as const;

export const anamnesisRpcRequestSchema = z.union([anamnesisRequestSchema, hubOps.host, hubOps.config, hubOps.pass]);
export type AnamnesisRpcRequest = z.infer<typeof anamnesisRpcRequestSchema>;

export const anamnesisRpcMethods = {
  anamnesis: {
    input: z.object({ request: anamnesisRpcRequestSchema }).strict(),
    output: z.object({ result: z.unknown() }).strict(),
  },
};
