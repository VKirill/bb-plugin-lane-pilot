import type Database from "better-sqlite3";

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
  evidence: OwnerEvidence[];
  actions: OwnerAction[];
};

export type OwnerWaiting = {
  generatedAt: number;
  items: OwnerItem[];
  /** Count per source, for the badge and the daily line. */
  counts: Record<string, number>;
  overnight: Overnight;
};

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
const tableExists = (db: Db, name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const parse = <T>(text: string | null | undefined, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };
const rpcLine = (method: string, input: Record<string, unknown>) => `echo '${JSON.stringify(input)}' > /tmp/owner-action.json && bb plugin rpc call lane-pilot ${method} --input-file /tmp/owner-action.json --json`;

function learningItems(db: Db): OwnerItem[] {
  if (!tableExists(db, "lane_pilot_learning_item")) return [];
  const rows = db.prepare("SELECT id, project_id, kind, text, evidence, created_at FROM lane_pilot_learning_item WHERE state='pending_owner' ORDER BY created_at DESC").all() as
    Array<{ id: string; project_id: string; kind: string; text: string; evidence: string; created_at: number }>;
  return rows.map((row) => ({
    key: `learning:${row.id}`, source: "learning", kind: `learning_${row.kind}`, projectId: row.project_id,
    what: clip(row.text, 300), why: "Это вывод из твоих слов, который меняет поведение всех проектов; принять его может только владелец.",
    since: row.created_at, wake: false, evidence: [{ kind: "text", ref: clip(row.evidence, 200) }],
    actions: (["accept", "reject"] as const).map((action) => ({ id: action, label: action === "accept" ? "Принять" : "Отклонить", cli: `bb lane-pilot learning ${action} ${row.id}` })),
  }));
}

function inbox(db: Db): OwnerItem[] {
  if (!tableExists(db, "lane_pilot_owner_item")) return [];
  const rows = db.prepare("SELECT key, source, kind, project_id, what, why, evidence_json, actions_json, wake, created_at FROM lane_pilot_owner_item WHERE state='open' ORDER BY created_at").all() as
    Array<{ key: string; source: string; kind: string; project_id: string | null; what: string; why: string; evidence_json: string; actions_json: string; wake: number; created_at: number }>;
  return rows.map((row) => ({
    key: row.key, source: row.source, kind: row.kind, projectId: row.project_id, what: row.what, why: row.why, since: row.created_at, wake: row.wake === 1,
    evidence: parse<OwnerEvidence[]>(row.evidence_json, []), actions: parse<OwnerAction[]>(row.actions_json, []),
  }));
}

export type PostOwnerItem = Omit<OwnerItem, "since" | "wake" | "evidence" | "actions" | "projectId"> & Partial<Pick<OwnerItem, "wake" | "evidence" | "actions" | "projectId">>;

/** The night loop's door: an open waiting with a stable `key`; posting the same key again changes nothing (one waiting, one row). */
export function postOwnerItem(db: Db, item: PostOwnerItem, now: number = Date.now()): { created: boolean } {
  if (!item.key.trim() || !item.what.trim() || !item.why.trim()) throw new Error("an owner item needs a key, what and why");
  const result = db.prepare(`INSERT OR IGNORE INTO lane_pilot_owner_item(key,source,kind,project_id,what,why,evidence_json,actions_json,wake,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,'open',?)`).run(item.key, item.source, item.kind, item.projectId ?? null, clip(item.what, 600), clip(item.why, 600),
    JSON.stringify(item.evidence ?? []), JSON.stringify(item.actions ?? []), item.wake === false ? 0 : 1, now);
  return { created: result.changes > 0 };
}

/** The owner answered (or the thing went away): the row leaves the screen and the digest. */
export function closeOwnerItem(db: Db, key: string, by: string, now: number = Date.now()): boolean {
  return db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_at=?, closed_by=? WHERE key=? AND state='open'").run(now, clip(by, 500), key).changes > 0;
}

export function overnight(db: Db, now: number = Date.now(), windowMs: number = OVERNIGHT_WINDOW_MS): Overnight {
  const since = now - windowMs;
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  const red = (db.prepare("SELECT state, id FROM lane_pilot_attempt WHERE updated_at>=? AND (state LIKE '%failed%' OR state IN ('blocked','provider_error')) ORDER BY state, updated_at DESC").all(since) as Array<{ state: string; id: string }>)
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

export function collectOwnerWaiting(db: Db, now: number = Date.now(), windowMs: number = OVERNIGHT_WINDOW_MS): OwnerWaiting {
  const items = [...learningItems(db), ...inbox(db)];
  const rank = (item: OwnerItem) => { const at = SOURCE_ORDER.indexOf(item.source); return at < 0 ? SOURCE_ORDER.indexOf("night") : at; };
  items.sort((a, b) => rank(a) - rank(b) || a.since - b.since || a.key.localeCompare(b.key));
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.source] = (counts[item.source] ?? 0) + 1;
  return { generatedAt: now, items, counts, overnight: overnight(db, now, windowMs) };
}

/** The counts behind the daily report's last line (scripts/lp-morning.sql counts the same, tests/policy/morning.test.ts keeps them equal). */
export function ownerWaitingCounts(db: Db, now: number = Date.now()): { overdue: number; open: number; inbox: number } {
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  return {
    // Only a human term can be overdue (deferral/store.ts HUMAN_TERM_SQL): an entry with the code's or an agent's term is «open, no term».
    overdue: count("SELECT count(*) AS n FROM lane_pilot_deferral WHERE state IN ('open','overdue') AND due_at < ? AND owner_ref IS NOT NULL AND due_source IN ('explicit','relative','weekday')", now),
    open: count("SELECT count(*) AS n FROM lane_pilot_deferral WHERE state = 'open' AND due_at >= ? AND owner_ref IS NOT NULL AND due_source IN ('explicit','relative','weekday')", now),
    inbox: count("SELECT count(*) AS n FROM lane_pilot_owner_item WHERE state='open'") + count("SELECT count(*) AS n FROM lane_pilot_learning_item WHERE state='pending_owner'"),
  };
}
