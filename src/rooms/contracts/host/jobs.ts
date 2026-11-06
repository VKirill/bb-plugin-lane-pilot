import { z } from "zod";
import { HOST_JOB_KINDS, HOST_JOB_MAX_SEC, hostJobId, hostJobRef } from "@lane-pilot/contracts";

/** Background jobs on the host (B4): a long call runs in a process of its own, polled by id. */
export const jobHostMethods = {
  jobStart: {
    // `key`: one logical job; a second start with the same key returns the first job (additive; an older host ignores it).
    input: z.object({ requestedHostId:z.string().min(1), kind:z.enum(HOST_JOB_KINDS), input:z.record(z.string(), z.unknown()), timeoutSec:z.number().int().min(10).max(HOST_JOB_MAX_SEC), key:z.string().min(1).max(200).optional() }).strict(),
    output: z.object({ hostId:z.string(), jobId:hostJobId }).strict(),
  },
  jobStatus: {
    input: hostJobRef,
    output: z.object({
      hostId:z.string(), jobId:hostJobId, state:z.enum(["running", "succeeded", "failed", "cancelled", "lost"]),
      progress:z.object({ startedAt:z.number(), updatedAt:z.number(), elapsedSec:z.number().int().nonnegative(), lastLine:z.string() }).strict(),
      result:z.unknown().optional(), error:z.string().nullable(),
    }).strict(),
  },
  jobCancel: {
    input: hostJobRef,
    output: z.object({ hostId:z.string(), jobId:hostJobId, cancelled:z.boolean() }).strict(),
  },
};
