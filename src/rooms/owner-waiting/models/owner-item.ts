import { OWNER_REASONS, type OwnerReason } from "@lane-pilot/contracts";
import { DRILL_SANDBOX_PROJECT_IDS } from "../../contracts";

/**
 * «Waiting for the owner» (SMA D0-3). Pure domain types, constants, classification and sandbox rules.
 * Runtime-neutral: no node:, no SQLite, no BB SDK — shared by ui/ and server/.
 */
export const OWNER_EVIDENCE_KINDS = ["attempt", "task", "run", "file", "note", "message", "command", "text"] as const;
export type OwnerEvidence = { kind: (typeof OWNER_EVIDENCE_KINDS)[number]; ref: string; label?: string };

export type OwnerAction = {
  id: string;
  label: string;
  /** The exact command (or `bb plugin rpc call …` line) that does it. */
  cli: string;
  /** Present when the screen can do it with one button: the plugin RPC and its input. */
  rpc?: { method: string; input: Record<string, unknown> };
  /** The action needs a message of his own (a deferral's term): the code reads the message and takes the date from it. */
  needsOwnerMessage?: boolean;
  /** How to get what the command needs (where the thread id and the event number come from). */
  hint?: string;
};

export type OwnerItem = {
  key: string;
  /** rule_proposal | learning | deferral | memory_conflict | the poster's own (night, wall, backlog …). */
  source: string;
  kind: string;
  projectId: string | null;
  what: string;
  why: string;
  since: number;
  wake: boolean;
  /** «now»: one of the NOW_CAP rows the owner sees first and the digest may push; «later» waits folded until a «now» row is settled (harness batch 2026-11-02). */
  tier: "now" | "later";
  /** True when deferred past today's decision budget to wait for the weekly review desk. */
  desk?: true;
  evidence: OwnerEvidence[];
  actions: OwnerAction[];
};

export type OwnerWaitingRow = OwnerItem;

export const defaultWakeForReason = (reason: OwnerReason): boolean => reason === "red";

export type OwnerAttention = {
  cap: number;
  shown: number;
  remaining: number;
  day: string;
};

export type OwnerWaiting = {
  generatedAt: number;
  items: OwnerItem[];
  /** Count per source, for the daily line. */
  counts: Record<string, number>;
  overnight: Overnight;
  /** How many rows are «now» (the rail badge shows this, not the whole list). */
  now: number;
  /** Who settled the rows closed in the last 7 days. */
  answered: Answered;
  /** Daily wake-decision attention budget (mirrors `decision_day` / `decision_day_keys` and `decisionCap`). */
  attention?: OwnerAttention;
};

/** The owner himself (the screen, his CLI), the helper thread that decides for him (`--by agent…`), the lead, the janitor (terms, rows whose question went away). */
export type Answered = { owner: number; agent: number; lead: number; janitor: number };

/**
 * At most this many rows are «now». The research of 2026-11-02 (synthesis §4 row 5): an inbox of 28 rows a day is answered by reflex, and a
 * reflex answer is not a decision; five ranked by the cost of putting them off are read. The rest wait folded and move up as rows close.
 */
export const NOW_CAP = 5;

/** The four reasons a person is called (SMA: Four reasons to call): a decision only they make, work that cannot go on, something red, a term that ends. */
export { OWNER_REASONS as CALL_REASONS };
export type CallReason = OwnerReason;
export function callReason(kind: string): CallReason {
  if (/canary|regress|red|outage/.test(kind)) return "red";
  if (/deferral|term|deadline|expire/.test(kind)) return "term";
  if (/wall|blocked|stuck|needs_human|stall/.test(kind)) return "blocked";
  return "decision";
}

/** The cost of putting a row off: something red first, then work that stands, then a term that ends, then a decision. */
export const REASON_RANK: Record<CallReason, number> = { red: 0, blocked: 1, term: 2, decision: 3 };

export type Overnight = {
  windowMs: number;
  red: Array<{ state: string; count: number; attempts: string[] }>;
  accepted: number;
  rulesAdopted: number;
  rulesConfirmed: number;
};

export const OVERNIGHT_WINDOW_MS = 24 * 3_600_000;
export const SOURCE_ORDER = ["night", "wall", "backlog"];

export const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const rpcLine = (method: string, input: Record<string, unknown>) =>
  `echo '${JSON.stringify(input)}' > /tmp/owner-action.json && bb plugin rpc call lane-pilot ${method} --input-file /tmp/owner-action.json --json`;

/**
 * The drill's sandbox projects («LP sandbox …»): what their tasks and phases ask is the drill's, not the owner's — it never reaches the
 * morning list, the digest or a push (live 2026-10-27: «Drill route … loop ran out of tries» and a drill writer's colour question, with a
 * push). The stability canary keeps the set current; every drill sandbox id is in it from the start.
 */
const sandboxProjects = new Set<string>(DRILL_SANDBOX_PROJECT_IDS);
export function setSandboxProjects(ids: Iterable<string>): void {
  for (const id of ids) sandboxProjects.add(id);
}
/** A sandbox or bench project (the canary's set): no row of it reaches the owner, and the lead keeps it out of its zone unless named. */
export const isSandboxProject = (projectId: string | null | undefined): boolean => !!projectId && sandboxProjects.has(projectId);

/** A row that asks nothing still needs a way off the screen before its term (Astra U-001, Gemini F-006.4): «Прочитано» closes it as the owner's. */
export const withReadButton = (key: string, actions: OwnerAction[]): OwnerAction[] =>
  actions.length ? actions : [{ id: "read", label: "Прочитано", cli: rpcLine("owner_waiting_close", { key }), rpc: { method: "owner_waiting_close", input: { key } } }];

export type PostOwnerItem = Omit<OwnerItem, "since" | "wake" | "tier" | "evidence" | "actions" | "projectId">
  & Partial<Pick<OwnerItem, "wake" | "evidence" | "actions" | "projectId">>
  & { reason: OwnerReason };

export type OwnerItemCreatedEvent = { key: string; projectId: string | null; kind: string; wake: boolean; now: number };

export type OpenOwnerItemFilter = { key?: string; source?: string; kind?: string; projectId?: string; since?: number; limit?: number };

/** How a person-decision row ended (SMA tr_approval_row): open is «awaiting»; closed_by is '<outcome>:<by>' with outcome approved, returned, closed or stopped. */
export function ownerItemOutcome(row: { state: string; closed_by: string | null }): "awaiting" | "approved" | "returned" | "closed" | "stopped" {
  if (row.state !== "closed") return "awaiting";
  const prefix = (row.closed_by ?? "").split(":")[0];
  return prefix === "approved" || prefix === "returned" || prefix === "stopped" ? prefix : "closed";
}

/** How long a row that asks nothing (no actions: a fact, a notice) stays on the list before the janitor takes it. */
export const OWNER_FACT_TTL_MS = 3 * 24 * 60 * 60_000;
/** How long a row without buttons that still describes something to do (a writer's question, a red gate) stays. */
export const OWNER_NOTE_TTL_MS = 7 * 24 * 60 * 60_000;
export const FACT_KINDS = new Set(["acted", "tick_error", "labels", "right_changed", "schedule_failed", "schedule_paused", "digest", "outage", "gate_machine", "gate_no_test", "rule_proposed"]);
