import { createHash } from "node:crypto";
import { z } from "zod";

export const STAGE_CONTRACT_VERSION = 1 as const;
export const STAGE_IDS = ["plan-critique", "writer-agent", "verification", "acceptance-receipt", "browser-qa"] as const;
export type StageId = (typeof STAGE_IDS)[number];
export const STAGE_STATES = ["pending", "running", "passed", "failed", "blocked", "skipped", "canceled"] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const stageReceiptSchema = z.object({
  contractVersion: z.literal(STAGE_CONTRACT_VERSION),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  stageId: z.enum(STAGE_IDS),
  state: z.enum(STAGE_STATES),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  attempt: z.number().int().min(0).max(2),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  threadId: z.string().nullable(),
  result: z.unknown().nullable(),
  reason: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export type StageReceipt = z.infer<typeof stageReceiptSchema>;

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stageTransition(from: StageState, to: StageState): boolean {
  if (from === to) return true;
  if (["passed", "failed", "blocked", "skipped", "canceled"].includes(from)) return false;
  if (from === "pending") return ["running", "blocked", "skipped", "canceled"].includes(to);
  return ["passed", "failed", "blocked", "canceled"].includes(to);
}

export function validateStageReceipt(value: unknown): StageReceipt {
  return stageReceiptSchema.parse(value);
}
