import { z } from "zod";

export const nativeSelectionSchema = z.object({
  token: z.string().uuid(),
  projectId: z.string().min(1),
  agentId: z.string().min(1).max(200),
  profileMode: z.enum(["installed", "session-override"]),
  agentsJson: z.string().max(200_000).nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  createdAt: z.number(),
  /** A PM's specialist thread: it works for this run and never opens a run of its own. */
  parentRunId: z.string().min(1).optional(),
}).strict();

export type NativeSelection = z.infer<typeof nativeSelectionSchema>;
