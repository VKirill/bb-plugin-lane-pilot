import { dayOf, type DueSource } from "./due";

export const DEFERRAL_KINDS = ["drill_scenario", "skipped_test", "gate", "plan_decision", "memory_conflict", "wall"] as const;
export type DeferralKind = (typeof DEFERRAL_KINDS)[number];
export type DeferralState = "open" | "overdue" | "closed" | "needs_owner_term";

/** Where the term came from: the owner's message, by thread, event sequence, the checked text's hash and the message's own time. */
export type OwnerRef = { threadId: string; seq: number; index: number; sha256: string; at: number };

export type Deferral = {
  id: string; projectId: string | null; what: string; kind: DeferralKind; area: string;
  dueAt: number | null; dueSource: DueSource | null; ownerRef: OwnerRef | null; ownerQuote: string | null;
  state: DeferralState; history: Array<{ dueAt: number | null; dueSource: string | null; ownerRef: OwnerRef | null; at: number }>;
  source: string; createdAt: number; updatedAt: number; closedAt: number | null; closedBy: string | null;
};

export type Counts = Record<DeferralState, number>;
export function countDeferrals(rows: readonly Deferral[]): Counts {
  const counts: Counts = { open: 0, overdue: 0, closed: 0, needs_owner_term: 0 };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

export type DeferInput = {
  /** The thing put off, or the id of an existing entry whose term is set or moved. */
  what: string;
  kind?: string | undefined;
  area?: string | undefined;
  projectId?: string | undefined;
  /** `<threadId>#<event seq>` of a message of the owner that names the term; without it an agent sets the term with `due` and `reason`. */
  ownerMsg?: string | undefined;
  /** Why the agent puts it off until `due` (no owner message). */
  reason?: string | undefined;
  /** The day the message names (2026-11-05); omitted: the one date in the text, or the default of 14 days. */
  due?: string | undefined;
};

export type DeferralView = {
  id: string; state: DeferralState; kind: DeferralKind; what: string; area: string; projectId: string | null;
  due: string | null; dueSource: string | null; ownerMsg: string | null; ownerQuote: string | null; closedBy: string | null;
};

export type DeferralList = {
  counts: Record<DeferralState, number>;
  overdue: DeferralView[];
  needsOwnerTerm: DeferralView[];
  entries: DeferralView[];
  /** Cited ids (`refs`) the register does not hold, or holds closed. */
  badRefs: Array<{ id: string; problem: "unknown" | "closed" }>;
};

export const view = (row: Deferral): DeferralView => ({
  id: row.id, state: row.state, kind: row.kind, what: row.what, area: row.area, projectId: row.projectId,
  due: row.dueAt === null ? null : dayOf(row.dueAt), dueSource: row.dueSource,
  ownerMsg: row.ownerRef ? `${row.ownerRef.threadId}#${row.ownerRef.seq}` : null, ownerQuote: row.ownerQuote, closedBy: row.closedBy,
});

const QUOTE_RADIUS = 140;
/** The words around the date in the owner's message, or its start. */
export function quoteOf(text: string, match: string | null): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = match ? flat.toLowerCase().indexOf(match.toLowerCase()) : -1;
  if (at < 0) return flat.slice(0, QUOTE_RADIUS * 2);
  const from = Math.max(0, at - QUOTE_RADIUS), to = Math.min(flat.length, at + match!.length + QUOTE_RADIUS);
  return `${from > 0 ? "…" : ""}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
}
