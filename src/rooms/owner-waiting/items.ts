import type Database from "better-sqlite3";

/**
 * «Waiting for the owner» (SMA D0-3): one read of everything that only the owner can decide, in one shape. Nothing here blocks anything:
 * the screen, the daily report and the Telegram digest show it, and the work goes on. The reader takes no new decision; it reads
 *  - rule proposals waiting (lane_pilot_rule_proposal, state proposed),
 *  - learned items waiting for him (lane_pilot_learning_item, pending_owner),
 *  - deferrals: an overdue term (the deploy drill is red) or no term yet (needs_owner_term), memory conflicts apart,
 *  - held memory conflicts (lane_pilot_memory_conflict),
 *  - the inbox `lane_pilot_owner_item`: whatever the night loop (proposals, walls, backlog escalations) posts with `postOwnerItem`.
 * A source whose table does not exist yet (an older database) gives nothing.
 *
 * The item shape is the contract with the night loop: a poster sets `key` (stable, so a repeat is the same waiting), `source`, `kind`,
 * `what`, `why` it is the owner's, `evidence` links and the `actions` the owner can take, each with the exact CLI line and, when the code
 * can do it, the RPC the screen's button calls. `wake` says whether a new item may reach his phone.
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
const SOURCE_ORDER = ["deferral_overdue", "night", "wall", "backlog", "memory_conflict", "rule_proposal", "learning", "deferral_term"];
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const tableExists = (db: Db, name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const parse = <T>(text: string | null | undefined, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };
const rpcLine = (method: string, input: Record<string, unknown>) => `echo '${JSON.stringify(input)}' > /tmp/owner-action.json && bb plugin rpc call lane-pilot ${method} --input-file /tmp/owner-action.json --json`;

const OWNER_MESSAGE_HINT = "Say the date in a message of your own in any BB chat («до 5 ноября», «через 2 недели»), then take that chat's id and the event number of the message (bb lane-pilot events-list <thread-id>). The code reads the message; an agent cannot set the date.";

function ruleProposals(db: Db): OwnerItem[] {
  if (!tableExists(db, "lane_pilot_rule_proposal")) return [];
  const rows = db.prepare("SELECT id, project_id, rule, author, occurrences, task_count, examples_json, evidence_json, last_seen_at FROM lane_pilot_rule_proposal WHERE state='proposed' ORDER BY last_seen_at DESC").all() as
    Array<{ id: string; project_id: string; rule: string; author: string; occurrences: number; task_count: number; examples_json: string; evidence_json: string; last_seen_at: number }>;
  return rows.map((row) => {
    const evidence = parse<Array<{ runId?: string; taskId?: string; attemptId?: string; reason?: string }>>(row.evidence_json, []).slice(0, 3)
      .flatMap((item): OwnerEvidence[] => item.attemptId ? [{ kind: "attempt", ref: item.attemptId, ...(item.reason ? { label: clip(item.reason, 120) } : {}) }] : []);
    const example = parse<string[]>(row.examples_json, [])[0];
    if (!evidence.length && example) evidence.push({ kind: "text", ref: clip(example, 160) });
    const decide = (action: "accept" | "reject") => ({ projectId: row.project_id, id: row.id, action });
    return {
      key: `rule:${row.project_id}:${row.id}`, source: "rule_proposal", kind: "rule_proposal", projectId: row.project_id,
      what: clip(row.rule, 300),
      why: `Правило, которое попадёт в промпты писателей, вводишь только ты (автор: ${row.author}; повторов ${row.occurrences}, задач ${row.task_count}).`,
      since: row.last_seen_at, wake: false, evidence,
      actions: (["accept", "reject"] as const).map((action) => ({
        id: action, label: action === "accept" ? "Принять правило" : "Отклонить", cli: rpcLine("decide_rule_proposal", decide(action)), rpc: { method: "decide_rule_proposal", input: decide(action) },
      })),
    };
  });
}

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

function deferrals(db: Db, now: number): OwnerItem[] {
  if (!tableExists(db, "lane_pilot_deferral")) return [];
  const rows = db.prepare("SELECT id, project_id, what, kind, area, due_at, owner_quote, state, created_at FROM lane_pilot_deferral WHERE kind <> 'memory_conflict' AND (state = 'needs_owner_term' OR (state IN ('open','overdue') AND due_at < ?)) ORDER BY due_at, created_at").all(now) as
    Array<{ id: string; project_id: string | null; what: string; kind: string; area: string; due_at: number | null; owner_quote: string | null; state: string; created_at: number }>;
  return rows.map((row) => {
    const overdue = row.state !== "needs_owner_term";
    const evidence: OwnerEvidence[] = [{ kind: "command", ref: `bb lane-pilot deferrals --state ${overdue ? "overdue" : "needs_owner_term"}`, label: row.id }];
    if (row.owner_quote) evidence.push({ kind: "message", ref: clip(row.owner_quote, 200), label: "твои слова, давшие срок" });
    const term: OwnerAction = {
      id: "term", label: overdue ? "Новый срок (твоим сообщением)" : "Назначить срок (твоим сообщением)", needsOwnerMessage: true,
      cli: `bb lane-pilot defer ${row.id} --owner-msg <threadId>#<seq> [--due YYYY-MM-DD]`, hint: OWNER_MESSAGE_HINT,
    };
    const close: OwnerAction = { id: "close", label: "Закрыть с доказательством", cli: `bb lane-pilot defer-close ${row.id} --evidence "<коммит, прогон теста, ссылка, решение>"`, hint: "Доказательство должно говорить, что закрывает отсрочку." };
    return {
      key: `deferral:${row.id}`, source: overdue ? "deferral_overdue" : "deferral_term", kind: `deferral_${row.kind}`, projectId: row.project_id,
      what: clip(row.what, 300),
      why: overdue
        ? "Срок, который ты дал, прошёл: учение перед выкаткой красное, пока отсрочку не закроют с доказательством или ты не дашь новую дату."
        : "У отсрочки нет срока: дату называешь только ты, сообщением, и ни агент, ни код не имеют права назначить её сами.",
      since: row.due_at ?? row.created_at, wake: overdue, evidence, actions: [term, close],
    };
  });
}

function memoryConflicts(db: Db): OwnerItem[] {
  if (!tableExists(db, "lane_pilot_memory_conflict")) return [];
  const rows = db.prepare("SELECT id, project_id, note_a, note_b, kind, subject, evidence_a, evidence_b, deferral_id, detected_at FROM lane_pilot_memory_conflict WHERE state='held' ORDER BY detected_at").all() as
    Array<{ id: string; project_id: string; note_a: string; note_b: string; kind: string; subject: string; evidence_a: string; evidence_b: string; deferral_id: string | null; detected_at: number }>;
  return rows.map((row) => ({
    key: `memory_conflict:${row.id}`, source: "memory_conflict", kind: `memory_conflict_${row.kind}`, projectId: row.project_id,
    what: clip(`Заметки памяти расходятся (${row.subject}): «${clip(row.evidence_a, 90)}» против «${clip(row.evidence_b, 90)}»`, 300),
    why: "Какая из двух заметок верна, агент проверить не может; обе убраны из всех брифов, пока человек не решит.",
    since: row.detected_at, wake: true,
    evidence: [{ kind: "note", ref: row.note_a, label: "заметка a" }, { kind: "note", ref: row.note_b, label: "заметка b" }, { kind: "command", ref: `bb lane-pilot memory-conflicts --project ${row.project_id} --state held`, label: row.id }],
    actions: [{ id: "settle", label: "Решить: оставить a, b, обе или ни одной", cli: `bb lane-pilot memory-conflict-settle ${row.id} --keep a|b|both|none --evidence "<почему, как проверил>"`, hint: "--keep выбирает, какая заметка остаётся; в --evidence напиши, как проверил." }],
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
  const items = [...deferrals(db, now), ...memoryConflicts(db), ...ruleProposals(db), ...learningItems(db), ...inbox(db)];
  const rank = (item: OwnerItem) => { const at = SOURCE_ORDER.indexOf(item.source); return at < 0 ? SOURCE_ORDER.indexOf("night") : at; };
  items.sort((a, b) => rank(a) - rank(b) || a.since - b.since || a.key.localeCompare(b.key));
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.source] = (counts[item.source] ?? 0) + 1;
  return { generatedAt: now, items, counts, overnight: overnight(db, now, windowMs) };
}

/** The counts behind the daily report's line (scripts/lp-morning.sql counts the same, tests/policy/morning.test.ts keeps them equal). */
export function ownerWaitingCounts(db: Db, now: number = Date.now()): { terms: number; overdue: number; conflicts: number; inbox: number } {
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  return {
    terms: count("SELECT count(*) AS n FROM lane_pilot_deferral WHERE state='needs_owner_term' AND kind <> 'memory_conflict'"),
    overdue: count("SELECT count(*) AS n FROM lane_pilot_deferral WHERE kind <> 'memory_conflict' AND state IN ('open','overdue') AND due_at < ?", now),
    conflicts: count("SELECT count(*) AS n FROM lane_pilot_memory_conflict WHERE state='held'"),
    inbox: count("SELECT count(*) AS n FROM lane_pilot_owner_item WHERE state='open'"),
  };
}
