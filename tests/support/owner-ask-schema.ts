import { z } from "zod";
import { ASK_KINDS, OWNER_ASK_MAX_OPTIONS, OWNER_ASK_SOURCES } from "../../src/rooms/relay/models/owner-ask";

export const ownerAskPayloadSchema = z.object({
  v: z.literal(1),
  source: z.enum(OWNER_ASK_SOURCES),
  kind: z.enum(ASK_KINDS).default("decision"),
  question: z.string().min(1).max(2000),
  detail: z.string().max(4000).optional(),
  options: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(120) })).max(OWNER_ASK_MAX_OPTIONS),
  allowText: z.boolean(),
});
