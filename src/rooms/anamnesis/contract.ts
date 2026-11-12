import { z } from "zod";
import { configSchema } from "./hub";
import { anamnesisRequestSchema, hostRequestSchema } from "./ops";

/**
 * The two entries anamnesis adds to the contracts, kept here so `src/contracts.ts` takes one line each:
 *  - the host method `anamnesis` (runs on the owner's machine, where the store is);
 *  - the RPC `anamnesis` (the hub; the CLI `bb lane-pilot anamnesis` and the later tab call it).
 * No agent tool is added anywhere: the PM's tool list is full.
 */
export const anamnesisHostMethods = {
  anamnesis: {
    // Since M1b the host answers only host-bound requests (collection scans, the portrait files, the migration export);
    // the store ops in `anamnesisRequestSchema` stay in the union so a stale caller gets the handler's refusal, not a schema error.
    input: z.object({ requestedHostId: z.string().min(1), request: z.union([anamnesisRequestSchema, hostRequestSchema]) }).strict(),
    output: z.object({ hostId: z.string(), response: z.unknown() }).strict(),
  },
};

/** What the hub itself does besides forwarding a store request. */
export const hubOps = {
  host: z.object({ op: z.literal("host"), hostId: z.string().min(1).optional() }).strict(),
  /** Reads the settings of anamnesis kept on the hub, or changes some of them (the extraction switch, the classifying ceiling, the Telegram channels). */
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
