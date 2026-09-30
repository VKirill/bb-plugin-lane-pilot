import { z } from "zod";

export const HANDOFF_STATES = ["queued", "delivered", "accepted", "in_progress", "done", "blocked", "rejected", "canceled", "expired"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

const TERMINAL: ReadonlySet<HandoffState> = new Set(["done", "blocked", "rejected", "canceled", "expired"]);

/** Every legal step. Anything not listed is refused by `transitionHandoff`. */
export const HANDOFF_TRANSITIONS: Readonly<Record<HandoffState, readonly HandoffState[]>> = {
  queued: ["delivered", "canceled", "expired"],
  delivered: ["accepted", "rejected", "canceled", "expired"],
  accepted: ["in_progress", "rejected", "canceled", "expired"],
  in_progress: ["done", "blocked", "rejected", "canceled", "expired"],
  done: [],
  blocked: [],
  rejected: [],
  canceled: [],
  expired: [],
};

export function canTransition(from: HandoffState, to: HandoffState): boolean {
  return HANDOFF_TRANSITIONS[from].includes(to);
}

export function isTerminalHandoffState(state: HandoffState): boolean {
  return TERMINAL.has(state);
}

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const handoffBudgetSchema = z.object({
  maxMinutes: z.number().int().min(1).max(24 * 60).optional(),
  maxTokens: z.number().int().min(1).optional(),
  maxTurns: z.number().int().min(1).max(500).optional(),
}).strict();

export const handoffInputSchema = z.object({
  kind: z.enum(["path", "thread", "url", "text"]),
  ref: shortText(2000),
  note: shortText(500).optional(),
}).strict();

/** What the sender fills in. Identity, state and timestamps are assigned by the store. */
export const handoffCardDraftSchema = z.object({
  fromAgent: shortText(120),
  toAgent: shortText(120),
  title: shortText(200),
  objective: shortText(4000),
  acceptance: z.array(shortText(1000)).min(1).max(20),
  inputs: z.array(handoffInputSchema).max(50).default([]),
  budget: handoffBudgetSchema.default({}),
  deadlineAt: z.number().int().positive().nullable().default(null),
}).strict();

export const handoffCardSchema = handoffCardDraftSchema.extend({
  id: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  ownerThreadId: z.string().min(1).nullable(),
  recipientThreadId: z.string().min(1).nullable(),
  state: z.enum(HANDOFF_STATES),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export type HandoffBudget = z.infer<typeof handoffBudgetSchema>;
export type HandoffInput = z.infer<typeof handoffInputSchema>;
export type HandoffCardDraft = z.infer<typeof handoffCardDraftSchema>;
export type HandoffCard = z.infer<typeof handoffCardSchema>;

export const handoffReceiptSchema = z.object({
  status: z.enum(["done", "blocked", "rejected"]),
  summary: shortText(4000),
  outputs: z.array(shortText(2000)).max(50).default([]),
  evidence: z.array(shortText(2000)).max(50).default([]),
}).strict();

export type HandoffReceipt = z.infer<typeof handoffReceiptSchema>;

function unfence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function parseJsonObject(raw: unknown, what: string): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(unfence(raw));
  } catch {
    throw new Error(`${what} must be a JSON object`);
  }
}

export function parseHandoffCard(raw: unknown): HandoffCardDraft {
  return handoffCardDraftSchema.parse(parseJsonObject(raw, "handoff card"));
}

export function parseHandoffReceipt(raw: unknown): HandoffReceipt {
  return handoffReceiptSchema.parse(parseJsonObject(raw, "handoff receipt"));
}

/** The receipt state a card reaches when the recipient answers. */
export function receiptState(receipt: HandoffReceipt): Extract<HandoffState, "done" | "blocked" | "rejected"> {
  return receipt.status;
}
