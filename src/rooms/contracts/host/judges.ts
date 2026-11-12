import { z } from "zod";

/** The System One judges (TypeSafe/OpenLux) the hub asks the host to call from its machine. */
export const judgeHostMethods = {
  councilJudge: {
    input: z.object({
      requestedHostId: z.string().min(1),
      jevApiKey: z.string().max(4096).optional(), jevProvider: z.enum(["openlux", "typesafe"]).optional(),
      /** The wait for System One's answer before the call counts as a timeout; the handler's own 4 s (plus the provider's pad) when absent. */
      timeoutMs: z.number().int().min(1000).max(60_000).optional(),
      state: z.string().min(1).max(60_000),
      questions: z.record(z.string().min(1).max(40), z.object({
        instructions: z.string().min(1).max(2000),
        criteria: z.record(z.string().min(1).max(40), z.string().min(1).max(500)),
      }).strict()).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 8, "1 to 8 questions"),
    }).strict(),
    output: z.object({
      hostId: z.string(), status: z.enum(["ok", "disabled", "timeout", "error"]),
      answers: z.record(z.string(), z.string()), confidence: z.record(z.string(), z.number()).optional(),
      // Per question, the probability of each criterion; `confidence` is not the probability of the chosen answer.
      probabilities: z.record(z.string(), z.record(z.string(), z.number())).optional(), reason: z.string().nullable(),
    }).strict(),
  },
};
