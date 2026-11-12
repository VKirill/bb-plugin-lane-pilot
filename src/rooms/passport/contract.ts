import { z } from "zod";

export const passportRpcMethods = {
  passport_get: {
    input: z
      .object({
        projectId: z.string().min(1),
        scopeKey: z.string().optional(),
      })
      .strict(),
    output: z.unknown(),
  },
  passport_save: {
    input: z
      .object({
        projectId: z.string().min(1),
        scopeKey: z.string().optional(),
        patch: z.record(z.string(), z.unknown()),
        ownerVerbatim: z.string().max(20_000).optional(),
        questionAsked: z.string().max(4_000).optional(),
      })
      .strict(),
    output: z.unknown(),
  },
  passport_decide: {
    input: z
      .object({
        projectId: z.string().min(1),
        deltaId: z.string().min(1),
        decision: z.enum(["accept", "reject"]),
      })
      .strict(),
    output: z.unknown(),
  },
};
