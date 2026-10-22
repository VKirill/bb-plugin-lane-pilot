import { MAX_AGENT_TERM_DAYS, dayOf, dayOfArg, defaultTermFrom, endOfDay, resolveTerm } from "./due";
import { seedDeferrals } from "./seed";
import {
  DEFERRAL_KINDS, closeDeferral, countDeferrals, dateUntermed, getDeferral, insertDeferral, listDeferrals, newDeferralId, setTerm, sweepOverdue,
  type Deferral, type DeferralDb, type DeferralKind, type DeferralState,
} from "./store";
import { verifyOwnerMessage, type OwnerMessagePort } from "./verify";

/**
 * The register of deferrals as one service (SMA rule 5): nothing is put off without a term. The owner takes no part (2026-10-22): an entry
 * the code opens gets the default term of 14 days, an agent sets or moves a term with `--due` and a `--reason` (at most 30 days ahead;
 * the history keeps every earlier term), and an overdue term turns the deploy drill red until an agent closes the entry with evidence
 * or gives it a new term with its reason. A message of the owner that names a date still sets the term when one is cited (`--owner-msg`).
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
    if (added) deps.log?.(`deferrals: ${added} first entries added (skipped tests and plan decisions, default term)`);
    const dated = dateUntermed(db, defaultTermFrom(at), at);
    if (dated) deps.log?.(`deferrals: ${dated} entries without a term got the default of 14 days`);
    return added;
  }

  async function defer(input: DeferInput): Promise<{ entry: DeferralView; created: boolean }> {
    const what = input.what.trim();
    if (!what) throw new Error("say what is put off: bb lane-pilot defer <what> --kind … --due <date> --reason <why>");
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

  /** A term an agent sets: a day at most 30 days ahead and the reason; an earlier term goes to the history. */
  function byAgent(existing: Deferral | null, kind: DeferralKind, what: string, input: DeferInput): { entry: DeferralView; created: boolean } {
    const reason = input.reason?.replace(/\s+/g, " ").trim() ?? "";
    if (reason.length < 8) throw new Error("--reason must say why it waits until then (what it waits for)");
    const day = input.due ? dayOfArg(input.due) : null;
    if (!day) throw new Error("--due must be a day, e.g. 2026-11-05");
    const at = now(), dueAt = endOfDay(day);
    if (dueAt < at) throw new Error(`--due ${day} has passed`);
    if (dueAt > at + MAX_AGENT_TERM_DAYS * 86_400_000) throw new Error(`--due ${day} is more than ${MAX_AGENT_TERM_DAYS} days ahead; put off a smaller step`);
    const quote = `agent: ${reason}`.slice(0, 300);
    if (existing) {
      setTerm(db, existing.id, { dueAt, dueSource: "agent", ownerRef: null, ownerQuote: quote }, at);
      return { entry: view(getDeferral(db, existing.id)!), created: false };
    }
    const row: Deferral = {
      id: "", projectId: input.projectId?.trim() || null, what, kind, area: input.area?.trim() ?? "", dueAt, dueSource: "agent", ownerRef: null, ownerQuote: quote,
      state: "open", history: [], source: "cli", createdAt: at, updatedAt: at, closedAt: null, closedBy: null,
    };
    for (let tries = 0; tries < 3; tries++) {
      row.id = newDeferralId();
      if (!getDeferral(db, row.id) && insertDeferral(db, row)) return { entry: view(getDeferral(db, row.id)!), created: true };
    }
    throw new Error("could not allocate a deferral id");
  }

  /** Opens an entry with the default term of 14 days, idempotent on `id` (a wall in the backlog, a held memory conflict). */
  function open(input: { id: string; kind: DeferralKind; what: string; area?: string; projectId?: string | null }): DeferralView {
    if (!(DEFERRAL_KINDS as readonly string[]).includes(input.kind)) throw new Error(`kind must be one of ${DEFERRAL_KINDS.join(", ")}`);
    const at = now();
    insertDeferral(db, {
      id: input.id, projectId: input.projectId ?? null, what: input.what.trim().slice(0, 500), kind: input.kind, area: input.area ?? "", dueAt: defaultTermFrom(at), dueSource: "default_14d",
      ownerRef: null, ownerQuote: null, state: "open", history: [], source: "code", createdAt: at, updatedAt: at, closedAt: null, closedBy: null,
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
  const live = listDeferrals(db, { projectId, states: ["open", "overdue"] });
  const overdue = live.filter((row) => row.state === "overdue" || (row.dueAt !== null && row.dueAt < at));
  const open = live.filter((row) => !overdue.includes(row));
  if (!overdue.length && !open.length) return [];
  const short = (row: Deferral): string => `${row.what.replace(/\s+/g, " ").slice(0, 80)} (${row.id}, term ${row.dueAt === null ? "none" : dayOf(row.dueAt)})`;
  const lines = ["Deferrals (read before you promise a date):"];
  if (overdue.length) lines.push(`- overdue ${overdue.length}: ${overdue.slice(0, 5).map(short).join("; ")}${overdue.length > 5 ? "; …" : ""}`);
  if (open.length) lines.push(`- open ${open.length}, next term ${dayOf(Math.min(...open.map((row) => row.dueAt ?? Infinity)))}`);
  if (overdue.length) lines.push("An overdue term turns the deploy drill red. Do the thing and close it with evidence (bb lane-pilot defer-close <id> --evidence …), or give it a new term with the reason (bb lane-pilot defer <id> --due <day> --reason <what it waits for>).");
  return lines;
}
