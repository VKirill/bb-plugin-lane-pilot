import type Database from "better-sqlite3";
import { DRILL_SANDBOX_PROJECT_IDS } from "../contracts";
import { countTermedDeferrals } from "../deferral/server";
import { listFailedAttemptsSince } from "../storage";

/**
 * «Waiting for the owner» (SMA D0-3). Since 2026-10-22 the owner takes no part in the loop: rules go on trial by themselves, a deferral
 * has no term unless his own message names a date (it is «open, no term» and counts as unproven in its project's phases), a memory conflict is settled by the newer note, a night repair the policy holds is logged.
 * What is left here is only what the owner's own words started:
 *  - learned items from his messages that wait for him (lane_pilot_learning_item, pending_owner: a reminder he asked for),
 *  - the inbox `lane_pilot_owner_item`: whatever a caller posts with `postOwnerItem` (nothing in the plugin posts there now).
 * Nothing here blocks anything. A source whose table does not exist yet (an older database) gives nothing.
 */
type Db = Pick<Database.Database, "prepare">;

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
  evidence: OwnerEvidence[];
  actions: OwnerAction[];
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
};

/** The owner himself (the screen, his CLI), the helper thread that decides for him (`--by agent…`), the lead, the janitor (terms, rows whose question went away). */
export type Answered = { owner: number; agent: number; lead: number; janitor: number };

/**
 * At most this many rows are «now». The research of 2026-11-02 (synthesis §4 row 5): an inbox of 28 rows a day is answered by reflex, and a
 * reflex answer is not a decision; five ranked by the cost of putting them off are read. The rest wait folded and move up as rows close.
 */
export const NOW_CAP = 5;

/** The four reasons a person is called (SMA: Four reasons to call): a decision only they make, work that cannot go on, something red, a term that ends. */
export const CALL_REASONS = ["decision", "blocked", "red", "term"] as const;
export type CallReason = (typeof CALL_REASONS)[number];
export function callReason(kind: string): CallReason {
  if (/canary|regress|red|outage/.test(kind)) return "red";
  if (/deferral|term|deadline|expire/.test(kind)) return "term";
  if (/wall|blocked|stuck|needs_human|stall/.test(kind)) return "blocked";
  return "decision";
}
/** The cost of putting a row off: something red first, then work that stands, then a term that ends, then a decision. */
const REASON_RANK: Record<CallReason, number> = { red: 0, blocked: 1, term: 2, decision: 3 };

export type Overnight = {
  windowMs: number;
  red: Array<{ state: string; count: number; attempts: string[] }>;
  accepted: number;
  rulesAdopted: number;
  rulesConfirmed: number;
};

export const OVERNIGHT_WINDOW_MS = 24 * 3_600_000;
const SOURCE_ORDER = ["night", "wall", "backlog", "learning"];
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export const tableExists = (db: Db, name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const parse = <T>(text: string | null | undefined, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };
export const rpcLine = (method: string, input: Record<string, unknown>) => `echo '${JSON.stringify(input)}' > /tmp/owner-action.json && bb plugin rpc call lane-pilot ${method} --input-file /tmp/owner-action.json --json`;

/** One pending_owner learning item row, as the learning room's reader returns it. */
export type PendingLearningItem = { id: string; project_id: string; kind: string; text: string; evidence: string; created_at: number };
/** The learning room's half of the morning list, handed over through Services: learning already imports this room. */
export type LearningItemsReader = (db: Db) => PendingLearningItem[];

function learningItems(db: Db, reader?: LearningItemsReader): OwnerItem[] {
  if (!tableExists(db, "lane_pilot_learning_item")) return [];
  const rows = reader?.(db) ?? [];
  return rows.map((row) => ({
    key: `learning:${row.id}`, source: "learning", kind: `learning_${row.kind}`, projectId: row.project_id,
    what: clip(row.text, 300), why: "Вы сказали это в чате. Если принять, все проекты будут так делать; если отклонить, это забудется. Решить можете только вы.",
    since: row.created_at, wake: false, tier: "later", evidence: [{ kind: "text", ref: clip(row.evidence, 200) }],
    actions: (["accept", "reject"] as const).map((action) => ({ id: action, label: action === "accept" ? "Принять" : "Отклонить", cli: `bb lane-pilot learning ${action} ${row.id}`, rpc: { method: "learning_decide", input: { id: row.id, action } } })),
  }));
}

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
const isSandbox = isSandboxProject;

function inbox(db: Db): OwnerItem[] {
  if (!tableExists(db, "lane_pilot_owner_item")) return [];
  const rows = db.prepare("SELECT key, source, kind, project_id, what, why, evidence_json, actions_json, wake, created_at FROM lane_pilot_owner_item WHERE state='open' ORDER BY created_at").all() as
    Array<{ key: string; source: string; kind: string; project_id: string | null; what: string; why: string; evidence_json: string; actions_json: string; wake: number; created_at: number }>;
  return rows.filter((row) => !isSandbox(row.project_id)).map((row) => ({
    key: row.key, source: row.source, kind: row.kind, projectId: row.project_id, what: row.what, why: row.why, since: row.created_at, wake: row.wake === 1, tier: "later",
    evidence: parse<OwnerEvidence[]>(row.evidence_json, []), actions: withReadButton(row.key, parse<OwnerAction[]>(row.actions_json, [])),
  }));
}

/** A row that asks nothing still needs a way off the screen before its term (Astra U-001, Gemini F-006.4): «Прочитано» closes it as the owner's. */
const withReadButton = (key: string, actions: OwnerAction[]): OwnerAction[] =>
  actions.length ? actions : [{ id: "read", label: "Прочитано", cli: rpcLine("owner_waiting_close", { key }), rpc: { method: "owner_waiting_close", input: { key } } }];

export type PostOwnerItem = Omit<OwnerItem, "since" | "wake" | "tier" | "evidence" | "actions" | "projectId"> & Partial<Pick<OwnerItem, "wake" | "evidence" | "actions" | "projectId">>;

/** The night loop's door: an open waiting with a stable `key`; posting the same key again changes nothing (one waiting, one row). */
export function postOwnerItem(db: Db, item: PostOwnerItem, now: number = Date.now()): { created: boolean } {
  if (!item.key.trim() || !item.what.trim() || !item.why.trim()) throw new Error("an owner item needs a key, what and why");
  if (isSandbox(item.projectId)) return { created: false };
  // The same key twice: a row the owner answered stays closed (his word stands); a row the system closed — the janitor's term, a run
  // goal that went green, a profile check that went green — is a new question when it comes back, so it reopens with the new text
  // (SWE-2 verification N-002: a closed key was a tombstone, and a second product question on the same task was dropped without a row).
  const result = db.prepare(`INSERT INTO lane_pilot_owner_item(key,source,kind,project_id,what,why,evidence_json,actions_json,wake,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,'open',?)
    ON CONFLICT(key) DO UPDATE SET source=excluded.source, kind=excluded.kind, project_id=excluded.project_id, what=excluded.what, why=excluded.why,
      evidence_json=excluded.evidence_json, actions_json=excluded.actions_json, wake=excluded.wake, state='open', created_at=excluded.created_at, closed_at=NULL, closed_by=NULL
    WHERE lane_pilot_owner_item.state='closed' AND (lane_pilot_owner_item.closed_by LIKE 'janitor:%' OR lane_pilot_owner_item.closed_by LIKE 'run-goal:%' OR lane_pilot_owner_item.closed_by LIKE 'profile-check:%')`).run(item.key, item.source, item.kind, item.projectId ?? null, clip(item.what, 600), clip(item.why, 600),
    JSON.stringify(item.evidence ?? []), JSON.stringify(item.actions ?? []), item.wake === false ? 0 : 1, now);
  return { created: result.changes > 0 };
}

/** The owner answered (or the thing went away): the row leaves the screen and the digest. */
export function closeOwnerItem(db: Db, key: string, by: string, now: number = Date.now()): boolean {
  return db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_at=?, closed_by=? WHERE key=? AND state='open'").run(now, clip(by, 500), key).changes > 0;
}

/** Did a person (or the agent deciding for him) close this row? A row the system closed — the janitor, a goal gone green — is not his answer. */
export function ownerAnsweredItem(db: Db, key: string): boolean {
  const row = db.prepare("SELECT closed_by FROM lane_pilot_owner_item WHERE key=? AND state='closed'").get(key) as { closed_by: string | null } | undefined;
  return !!row?.closed_by && !/^(janitor|run-goal|profile-check):/.test(row.closed_by);
}

/** Every open row under a key prefix (a question asked once per attempt: `task-word:<run>:<family>:`); returns how many closed. */
export function closeOwnerItemsByPrefix(db: Db, prefix: string, by: string, now: number = Date.now()): number {
  return db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_at=?, closed_by=? WHERE state='open' AND substr(key, 1, ?)=?").run(now, clip(by, 500), prefix.length, prefix).changes;
}

/** How many rows already exist under a key prefix — the next episode's sequence number, so a repost after a close is a fresh row. */
export function ownerItemPrefixCount(db: Db, prefix: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_owner_item WHERE substr(key, 1, ?)=?").get(prefix.length, prefix) as { n: number }).n;
}

export type OpenOwnerItemFilter = { key?: string; source?: string; kind?: string; projectId?: string; since?: number };

const openOwnerItemWhere = (filter: OpenOwnerItemFilter): { where: string; params: unknown[] } => {
  const where = ["state='open'"], params: unknown[] = [];
  if (filter.key !== undefined) { where.push("key=?"); params.push(filter.key); }
  if (filter.source !== undefined) { where.push("source=?"); params.push(filter.source); }
  if (filter.kind !== undefined) { where.push("kind=?"); params.push(filter.kind); }
  if (filter.projectId !== undefined) { where.push("project_id=?"); params.push(filter.projectId); }
  if (filter.since !== undefined) { where.push("created_at>?"); params.push(filter.since); }
  return { where: where.join(" AND "), params };
};

export function hasOpenOwnerItem(db: Db, filter: OpenOwnerItemFilter): boolean {
  const { where, params } = openOwnerItemWhere(filter);
  return db.prepare(`SELECT 1 FROM lane_pilot_owner_item WHERE ${where} LIMIT 1`).get(...params) !== undefined;
}

export function countOpenOwnerItems(db: Db, filter: OpenOwnerItemFilter): number {
  const { where, params } = openOwnerItemWhere(filter);
  return (db.prepare(`SELECT COUNT(*) AS n FROM lane_pilot_owner_item WHERE ${where}`).get(...params) as { n: number }).n;
}

export function listOpenOwnerItemKeys(db: Db, filter: OpenOwnerItemFilter): string[] {
  const { where, params } = openOwnerItemWhere(filter);
  return (db.prepare(`SELECT key FROM lane_pilot_owner_item WHERE ${where}`).all(...params) as Array<{ key: string }>).map((row) => row.key);
}

/** How long a row that asks nothing (no actions: a fact, a notice) stays on the list before the janitor takes it. */
export const OWNER_FACT_TTL_MS = 3 * 24 * 60 * 60_000;
/** How long a row without buttons that still describes something to do (a writer's question, a red gate) stays. */
export const OWNER_NOTE_TTL_MS = 7 * 24 * 60 * 60_000;
const FACT_KINDS = new Set(["handed", "acted", "tick_error", "tick_no_receipt", "labels", "right_changed", "schedule_failed", "schedule_paused", "digest", "outage", "gate_machine", "gate_no_test", "rule_proposed", "backlog_ready"]);

/**
 * A room whose rows sit on the owner's list answers «janitor:<why>» when the row's question is gone (the writer's task moved on, the
 * run closed, the schedule paused or gone), null while it still stands. The sweep calls the probe for every open row; the probe keeps
 * its own table query, so the room's key format and schema change in one place.
 */
export type OwnerItemSweep = (db: Pick<Database.Database, "prepare">, item: { key: string; kind: string; created_at: number }) => string | null;

/**
 * The list shows what still waits; a row whose question went away is closed here, on every read (SWE-2 F-004..F-006, Gemini F-006:
 * «an inbox where rows are born and never die»). Two cases the posters cannot see themselves:
 *  - a row whose owner says it is gone (`sweeps`: the writer's question, a red run goal, a phase's word, a failed schedule run);
 *  - a row with no action after its term: a fact after three days, anything else without buttons after seven.
 */
export function sweepOwnerItems(db: Db, now: number = Date.now(), sweeps: readonly OwnerItemSweep[] = []): number {
  if (!tableExists(db, "lane_pilot_owner_item")) return 0;
  let closed = 0;
  const rows = db.prepare("SELECT key, kind, actions_json, created_at FROM lane_pilot_owner_item WHERE state='open'").all() as Array<{ key: string; kind: string; actions_json: string; created_at: number }>;
  const close = (key: string, by: string) => { closed += closeOwnerItem(db, key, by, now) ? 1 : 0; };
  for (const row of rows) {
    const gone = sweeps.map((sweep) => sweep(db, row)).find((reason) => reason !== null);
    if (gone) { close(row.key, gone); continue; }
    // A failure row keeps its buttons, but a fact three days old is no longer news: it leaves with the other facts.
    if ((row.kind === "schedule_failed" || parse<OwnerAction[]>(row.actions_json, []).length === 0) && now - row.created_at > (FACT_KINDS.has(row.kind) ? OWNER_FACT_TTL_MS : OWNER_NOTE_TTL_MS)) close(row.key, "janitor:term");
  }
  return closed;
}

export function overnight(db: Db, now: number = Date.now(), windowMs: number = OVERNIGHT_WINDOW_MS): Overnight {
  const since = now - windowMs;
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  const red = listFailedAttemptsSince(db as Database.Database, since)
    .reduce<Overnight["red"]>((groups, row) => {
      const group = groups.find((item) => item.state === row.state) ?? groups[groups.push({ state: row.state, count: 0, attempts: [] }) - 1]!;
      group.count += 1;
      if (group.attempts.length < 5) group.attempts.push(row.id);
      return groups;
    }, []);
  return {
    windowMs, red,
    accepted: count("SELECT count(*) AS n FROM lane_pilot_attempt WHERE state='accepted' AND updated_at>=?", since),
    rulesAdopted: count("SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='adopted' AND at>=?", since),
    rulesConfirmed: count("SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='confirmed' AND at>=?", since),
  };
}

export function collectOwnerWaiting(db: Db, now: number = Date.now(), sweeps: readonly OwnerItemSweep[] = [], windowMs: number = OVERNIGHT_WINDOW_MS, learningReader?: LearningItemsReader): OwnerWaiting {
  sweepOwnerItems(db, now, sweeps);
  const items = [...learningItems(db, learningReader), ...inbox(db)];
  const rank = (item: OwnerItem) => { const at = SOURCE_ORDER.indexOf(item.source); return at < 0 ? SOURCE_ORDER.indexOf("night") : at; };
  // The cost of putting a row off first, a row that would push before one that would not, then the sources' order and age; the first NOW_CAP are «now».
  items.sort((a, b) => REASON_RANK[callReason(a.kind)] - REASON_RANK[callReason(b.kind)] || Number(b.wake) - Number(a.wake) || rank(a) - rank(b) || a.since - b.since || a.key.localeCompare(b.key));
  items.forEach((item, index) => { item.tier = index < NOW_CAP ? "now" : "later"; });
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.source] = (counts[item.source] ?? 0) + 1;
  return { generatedAt: now, items, counts, overnight: overnight(db, now, windowMs), now: Math.min(items.length, NOW_CAP), answered: answered(db, now) };
}

/** Who closed the rows of the last 7 days (the answer statistics the research asked for: a reflex inbox shows as «janitor» and «agent», never «owner»). */
export function answered(db: Db, now: number = Date.now()): Answered {
  const out: Answered = { owner: 0, agent: 0, lead: 0, janitor: 0 };
  if (!tableExists(db, "lane_pilot_owner_item")) return out;
  const rows = db.prepare("SELECT closed_by AS by, count(*) AS n FROM lane_pilot_owner_item WHERE state='closed' AND closed_at>=? GROUP BY closed_by").all(now - 7 * 24 * 3_600_000) as Array<{ by: string | null; n: number }>;
  for (const row of rows) {
    const by = row.by ?? "";
    const who: keyof Answered = by.startsWith("janitor:") || by.startsWith("run-goal:") ? "janitor" : by.startsWith("lead") ? "lead" : by.startsWith("agent") ? "agent" : "owner";
    out[who] += row.n;
  }
  return out;
}

/** The counts behind the daily report's last line (scripts/lp-morning.sql counts the same, tests/policy/morning.test.ts keeps them equal). */
export function ownerWaitingCounts(db: Db, now: number = Date.now(), sweeps: readonly OwnerItemSweep[] = []): { overdue: number; open: number; inbox: number } {
  sweepOwnerItems(db, now, sweeps); // the badge counts what still waits, not what the janitor would close on the next read
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  return {
    // Only a human term can be overdue (deferral/store.ts HUMAN_TERM_SQL): an entry with the code's or an agent's term is «open, no term».
    overdue: countTermedDeferrals(db, { states: ["open","overdue"], dueBefore: now }),
    open: countTermedDeferrals(db, { states: ["open"], dueAtLeast: now }),
    inbox: count("SELECT count(*) AS n FROM lane_pilot_owner_item WHERE state='open'") + count("SELECT count(*) AS n FROM lane_pilot_learning_item WHERE state='pending_owner'"),
  };
}
