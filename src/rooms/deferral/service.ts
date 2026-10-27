import { dayOf, resolveTerm } from "./due";
import { seedDeferrals } from "./seed";
import {
  DEFERRAL_KINDS, closeDeferral, countDeferrals, getDeferral, insertDeferral, listDeferrals, newDeferralId, setTerm, sweepOverdue,
  type Deferral, type DeferralDb, type DeferralKind, type DeferralState,
} from "./store";
import { verifyOwnerMessage, type OwnerMessagePort } from "./verify";

/**
 * The register of deferrals as one service (SMA rule 5): only a human sets the term of a mandatory check (Matvey Maslov). The owner takes
 * no part in the loop (2026-10-22), so an entry the code or an agent opens has NO term: it is «open, no term», never turns overdue
 * silently in a list nobody reads, and counts as unproven in the acceptance of the phases of its project (`noTermDeferralsOf`) until an
 * agent closes it with evidence. A message of the owner that names a date sets the term (`--owner-msg`); an agent cannot.
 */
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

export function createDeferrals(deps: { db: DeferralDb; port: OwnerMessagePort; now?: () => number; log?: (line: string) => void }) {
  const now = deps.now ?? Date.now;
  const { db, port } = deps;

  function seed(): number {
    const at = now();
    const added = seedDeferrals(db, at);
    if (added) deps.log?.(`deferrals: ${added} first entries added (skipped tests and plan decisions, no term)`);
    return added;
  }

  async function defer(input: DeferInput): Promise<{ entry: DeferralView; created: boolean }> {
    const what = input.what.trim();
    if (!what) throw new Error("say what is put off: bb lane-pilot defer <what> --kind … --reason <why>");
    const existing = /^dfr_/.test(what) ? getDeferral(db, what) : null;
    if (/^dfr_/.test(what) && !existing) throw new Error(`no deferral ${what}`);
    if (existing?.state === "closed") throw new Error(`${existing.id} is closed (${existing.closedBy ?? "no evidence"}); open a new entry if it is put off again`);
    const kind = existing?.kind ?? input.kind;
    if (!kind || !(DEFERRAL_KINDS as readonly string[]).includes(kind)) throw new Error(`--kind must be one of ${DEFERRAL_KINDS.join(", ")}`);
    if (what.length > 500) throw new Error("what is longer than 500 characters; name the thing, put the detail in the plan");

    if (!input.ownerMsg) return byAgent(existing, kind as DeferralKind, what, input);
    const checked = await verifyOwnerMessage(port, input.ownerMsg);
    if (!checked.ok) throw new Error(checked.error);
    const { message } = checked;
    const previous = existing?.ownerRef;
    if (previous && (message.at <= previous.at || (message.threadId === previous.threadId && message.seq === previous.seq))) {
      throw new Error(`${existing!.id} already has a term from the owner's message ${previous.threadId}#${previous.seq}; moving it needs a NEWER message from the owner, not an agent's decision`);
    }
    const resolved = resolveTerm(message.text, message.at, input.due);
    if (!resolved.ok) throw new Error(resolved.error);
    const { term } = resolved;
    const ownerRef = { threadId: message.threadId, seq: message.seq, index: message.index, sha256: message.sha256, at: message.at };
    const ownerQuote = quoteOf(message.text, term.match);
    const at = now();

    if (existing) {
      setTerm(db, existing.id, { dueAt: term.dueAt, dueSource: term.source, ownerRef, ownerQuote }, at);
      return { entry: view(getDeferral(db, existing.id)!), created: false };
    }
    const row: Deferral = {
      id: "", projectId: input.projectId?.trim() || null, what, kind: kind as DeferralKind, area: input.area?.trim() ?? "",
      dueAt: term.dueAt, dueSource: term.source, ownerRef, ownerQuote, state: term.dueAt < at ? "overdue" : "open",
      history: [], source: "cli", createdAt: at, updatedAt: at, closedAt: null, closedBy: null,
    };
    // A fresh id; the insert is retried only on the (practically impossible) clash.
    for (let tries = 0; tries < 3; tries++) {
      row.id = newDeferralId();
      if (!getDeferral(db, row.id) && insertDeferral(db, row)) return { entry: view(getDeferral(db, row.id)!), created: true };
    }
    throw new Error("could not allocate a deferral id");
  }

  /** An agent puts a thing off: the entry is born without a term. It cannot set or move one (only the owner's message does). */
  function byAgent(existing: Deferral | null, kind: DeferralKind, what: string, input: DeferInput): { entry: DeferralView; created: boolean } {
    if (input.due) throw new Error("an agent does not set a term: only a date in the owner's message does (--owner-msg). An entry without one stays open with no term and counts as unproven in its project's phases; close it with evidence (defer-close) when it is done");
    if (existing) return { entry: view(existing), created: false };
    const reason = input.reason?.replace(/\s+/g, " ").trim() ?? "";
    if (reason.length < 8) throw new Error("--reason must say what it waits for");
    const at = now();
    const row: Deferral = {
      id: "", projectId: input.projectId?.trim() || null, what, kind, area: input.area?.trim() ?? "", dueAt: null, dueSource: null, ownerRef: null, ownerQuote: `agent: ${reason}`.slice(0, 300),
      state: "needs_owner_term", history: [], source: "cli", createdAt: at, updatedAt: at, closedAt: null, closedBy: null,
    };
    for (let tries = 0; tries < 3; tries++) {
      row.id = newDeferralId();
      if (!getDeferral(db, row.id) && insertDeferral(db, row)) return { entry: view(getDeferral(db, row.id)!), created: true };
    }
    throw new Error("could not allocate a deferral id");
  }

  /** Opens an entry with no term, idempotent on `id` (a held memory conflict). */
  function open(input: { id: string; kind: DeferralKind; what: string; area?: string; projectId?: string | null }): DeferralView {
    if (!(DEFERRAL_KINDS as readonly string[]).includes(input.kind)) throw new Error(`kind must be one of ${DEFERRAL_KINDS.join(", ")}`);
    const at = now();
    insertDeferral(db, {
      id: input.id, projectId: input.projectId ?? null, what: input.what.trim().slice(0, 500), kind: input.kind, area: input.area ?? "", dueAt: null, dueSource: null,
      ownerRef: null, ownerQuote: null, state: "needs_owner_term", history: [], source: "code", createdAt: at, updatedAt: at, closedAt: null, closedBy: null,
    }, true);
    return view(getDeferral(db, input.id)!);
  }

  function close(input: { id: string; evidence: string }): DeferralView {
    const row = getDeferral(db, input.id.trim());
    if (!row) throw new Error(`no deferral ${input.id}`);
    if (row.state === "closed") throw new Error(`${row.id} is already closed (${row.closedBy ?? "no evidence"})`);
    const evidence = input.evidence.trim();
    if (evidence.length < 8) throw new Error("--evidence must say what closes it: a commit, a test run, a link, a decision with its reason");
    closeDeferral(db, row.id, evidence.slice(0, 2_000), now());
    return view(getDeferral(db, row.id)!);
  }

  function list(query: { projectId?: string | undefined; state?: string | undefined; refs?: readonly string[] | undefined } = {}): DeferralList {
    sweepOverdue(db, now());
    const all = listDeferrals(db, { projectId: query.projectId });
    const wanted = query.state ? all.filter((row) => row.state === query.state) : all.filter((row) => row.state !== "closed");
    const byId = new Map(listDeferrals(db).map((row) => [row.id, row]));
    const badRefs = [...new Set(query.refs ?? [])].flatMap((id): DeferralList["badRefs"] => {
      const row = byId.get(id);
      return !row ? [{ id, problem: "unknown" }] : row.state === "closed" ? [{ id, problem: "closed" }] : [];
    });
    return {
      counts: countDeferrals(all),
      overdue: all.filter((row) => row.state === "overdue").map(view),
      needsOwnerTerm: all.filter((row) => row.state === "needs_owner_term").map(view),
      entries: wanted.map(view),
      badRefs,
    };
  }

  return { seed, open, defer, close, list };
}
export type DeferralApi = ReturnType<typeof createDeferrals>;

/**
 * What a PM reads before it promises a date (SMA rule 6), as lines of its task-result message: the overdue and the open deferrals
 * of its project and the global ones. Nothing when there is none.
 */
export function pmDeferralLines(db: DeferralDb, projectId: string, at: number): string[] {
  const live = listDeferrals(db, { projectId, states: ["open", "overdue", "needs_owner_term"] });
  const noTerm = live.filter((row) => row.state === "needs_owner_term");
  const overdue = live.filter((row) => row.state === "overdue" || (row.state === "open" && row.dueAt !== null && row.dueAt < at));
  const open = live.filter((row) => !overdue.includes(row) && !noTerm.includes(row));
  if (!overdue.length && !open.length && !noTerm.length) return [];
  const short = (row: Deferral): string => `${row.what.replace(/\s+/g, " ").slice(0, 80)} (${row.id}, term ${row.dueAt === null ? "none" : dayOf(row.dueAt)})`;
  const lines = ["Deferrals (read before you promise a date):"];
  if (overdue.length) lines.push(`- overdue ${overdue.length}: ${overdue.slice(0, 5).map(short).join("; ")}${overdue.length > 5 ? "; …" : ""}`);
  if (open.length) lines.push(`- open ${open.length}, next term ${dayOf(Math.min(...open.map((row) => row.dueAt ?? Infinity)))}`);
  if (noTerm.length) lines.push(`- open, no term ${noTerm.length}: ${noTerm.slice(0, 5).map(short).join("; ")}${noTerm.length > 5 ? "; …" : ""}`);
  if (overdue.length) lines.push("An overdue term turns the deploy drill red. Do the thing and close it with evidence (bb lane-pilot defer-close <id> --evidence …); only a date in the owner's own message moves a term.");
  if (noTerm.length) lines.push("An entry with no term from the owner counts as unproven in this project's phase acceptance until it is closed with evidence (bb lane-pilot defer-close <id> --evidence …); an agent cannot give it a term.");
  return lines;
}
