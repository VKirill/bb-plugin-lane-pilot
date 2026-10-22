import type Database from "better-sqlite3";
import { sha256Hex } from "@lane-pilot/kit";
import { EXAM_LIVE, liveItemSchema, type LiveExam, type LiveItem } from "./exam";
import { POLICY, type ChangeDescriptor, type Policy, type Tier } from "./policy";

/**
 * The growing exam (exam v2). At night `collectOwnerDecisions` turns the owner's new decisions into items and `appendLiveItems` adds them to
 * the plugin store; nothing is ever edited or removed. The committed policy/exam-v2.json holds what was exported from the store earlier.
 * Only decisions made after the policy version's freeze can score it (`unseenItems` in exam.ts), so collecting never leaks a decision the
 * policy could have been written from.
 *
 * Sources, all automatic except the last:
 *   - rule proposals the owner accepted, rejected or took back (`lane_pilot_rule_event` owner_*): he decided that rule himself -> night_proposes
 *   - auto-adopted rules he left standing for STANDING_DAYS without revoking them: weak silence -> night_decides
 *   - learning observations he labelled (`learning label <id> ok|wrong`): ok -> night_decides, wrong -> night_proposes
 *   - owner messages that approve or refuse a change: `recordOwnerDecision`, called by whoever reads the message (CLI `policy exam-add`)
 */
type Db = Pick<Database.Database, "prepare">;
type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };

export const LIVE_EXAM_KEY = "policy:exam-v2";
/** BB's plugin store refuses a value over 256 KB; stop well before it. Past this, export the store into policy/exam-v2.json and start a new key. */
export const LIVE_STORE_LIMIT_BYTES = 200_000;
export const STANDING_DAYS = 7;
const DAY_MS = 24 * 3_600_000;
const QUOTE_MAX = 300;

const iso = (ms: number) => new Date(ms).toISOString();
const clip = (text: string) => (text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1)}…` : text);
export const liveItemId = (type: string, ref: string, decision: string): string => `y_${sha256Hex(`${type}|${ref}|${decision}`).slice(0, 12)}`;

/** The committed items plus those in the store, deduplicated by id, oldest decision first. */
export async function loadLiveExam(kv: Kv): Promise<LiveExam> {
  const stored = (await kv.get<unknown[]>(LIVE_EXAM_KEY)) ?? [];
  const byId = new Map<string, LiveItem>();
  for (const item of [...EXAM_LIVE.items, ...stored.map((raw) => liveItemSchema.parse(raw))]) if (!byId.has(item.id)) byId.set(item.id, item);
  return { ...EXAM_LIVE, items: [...byId.values()].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at)) };
}

/** Appends new items to the store. An item whose id is already known (committed or stored) is skipped; stored items are never changed. */
export async function appendLiveItems(kv: Kv, items: readonly LiveItem[]): Promise<{ added: number; skipped: number; total: number }> {
  const known = new Set((await loadLiveExam(kv)).items.map((item) => item.id));
  const stored = (await kv.get<LiveItem[]>(LIVE_EXAM_KEY)) ?? [];
  const fresh: LiveItem[] = [];
  for (const raw of items) {
    const item = liveItemSchema.parse(raw);
    if (known.has(item.id)) continue;
    known.add(item.id);
    fresh.push(item);
  }
  if (!fresh.length) return { added: 0, skipped: items.length, total: known.size };
  const next = [...stored, ...fresh];
  if (JSON.stringify(next).length > LIVE_STORE_LIMIT_BYTES) throw new Error(`exam-v2 store would pass ${LIVE_STORE_LIMIT_BYTES} bytes: export it into policy/exam-v2.json (bb lane-pilot policy exam-export) first`);
  await kv.set(LIVE_EXAM_KEY, next as never);
  return { added: fresh.length, skipped: items.length - fresh.length, total: known.size };
}

type RuleRow = { event_id: number; project_id: string; rule_id: string; action: string; detail: string | null; at: number; rule: string; always_on: number };

/** Owner decisions made after `since` (ms), as exam items. Reads the hub tables only; writes nothing. */
export function collectOwnerDecisions(db: Db, since: number, now: number = Date.now()): LiveItem[] {
  const items: LiveItem[] = [];

  const decisions = db.prepare(`SELECT e.id AS event_id, e.project_id, e.rule_id, e.action, e.detail, e.at, p.rule, p.always_on
      FROM lane_pilot_rule_event e JOIN lane_pilot_rule_proposal p ON p.project_id=e.project_id AND p.id=e.rule_id
      WHERE e.action IN ('owner_rejected','owner_accepted','owner_revoked') AND e.at>? ORDER BY e.at`).all(since) as RuleRow[];
  for (const row of decisions) {
    const ref = `${row.project_id}/${row.rule_id}#${row.action}`;
    items.push({
      id: liveItemId("rule_proposal", ref, row.action), source: { type: "rule_proposal", ref, date: iso(row.at).slice(0, 10) }, decided_at: iso(row.at),
      quote: clip(`${row.action}${row.detail ? ` (${row.detail})` : ""}: ${row.rule}`),
      descriptor: { kind: "rule_adopt", attrs: { trial: true, always_on: row.always_on === 1 } },
      expected: "night_proposes", strength: "medium", why: `The owner ${row.action.replace("owner_", "")} this rule himself; the rule store keeps no note with the decision.`,
    });
  }

  const standing = db.prepare(`SELECT e.project_id, e.rule_id, e.at, p.rule, p.always_on FROM lane_pilot_rule_event e
      JOIN lane_pilot_rule_proposal p ON p.project_id=e.project_id AND p.id=e.rule_id
      WHERE e.action='adopted' AND p.state='accepted' AND e.at+?>? AND e.at+?<=?
        AND NOT EXISTS (SELECT 1 FROM lane_pilot_rule_event o WHERE o.project_id=e.project_id AND o.rule_id=e.rule_id AND o.action IN ('owner_rejected','owner_revoked'))
      ORDER BY e.at`).all(STANDING_DAYS * DAY_MS, since, STANDING_DAYS * DAY_MS, now) as Array<{ project_id: string; rule_id: string; at: number; rule: string; always_on: number }>;
  for (const row of standing) {
    const ref = `${row.project_id}/${row.rule_id}#left_standing`;
    const decidedAt = row.at + STANDING_DAYS * DAY_MS;
    items.push({
      id: liveItemId("rule_proposal", ref, "left_standing"), source: { type: "rule_proposal", ref, date: iso(decidedAt).slice(0, 10) }, decided_at: iso(decidedAt),
      quote: clip(`adopted by the night, not revoked in ${STANDING_DAYS} days: ${row.rule}`),
      descriptor: { kind: "rule_adopt", attrs: { trial: true, always_on: row.always_on === 1 } },
      expected: "night_decides", strength: "weak", why: `The night put this rule on trial and the owner left it for ${STANDING_DAYS} days (silence, not approval).`,
    });
  }

  const labelled = db.prepare("SELECT id, review, reviewed_at, kind, final_route, excerpt FROM lane_pilot_learning_obs WHERE review IN ('ok','wrong') AND sensitive=0 AND reviewed_at>? ORDER BY reviewed_at").all(since) as
    Array<{ id: string; review: "ok" | "wrong"; reviewed_at: number; kind: string | null; final_route: string | null; excerpt: string | null }>;
  for (const row of labelled) {
    items.push({
      id: liveItemId("learning_observation", row.id, row.review), source: { type: "learning_observation", ref: row.id, date: iso(row.reviewed_at).slice(0, 10) }, decided_at: iso(row.reviewed_at),
      quote: clip(`label ${row.review}: ${row.excerpt ?? "(no excerpt)"}`),
      descriptor: { kind: "learning_item_adopt", attrs: { item_kind: row.kind ?? "none", route: row.final_route ?? "none" } },
      expected: row.review === "ok" ? "night_decides" : "night_proposes", strength: "medium",
      why: row.review === "ok" ? "The owner confirmed the system's own judgment of his message." : "The owner marked the system's judgment of his message wrong: it should have asked.",
    });
  }
  return items;
}

export type OwnerDecisionInput = {
  /** His words. */
  quote: string;
  /** Where they are: a thread id, message id or file. */
  ref: string;
  /** When he said it (ms). */
  at: number;
  descriptor: ChangeDescriptor;
  expected: Tier;
  strength?: LiveItem["strength"];
  why: string;
};

/** An owner message that approves or refuses a change, as an exam item. */
export function recordOwnerDecision(input: OwnerDecisionInput): LiveItem {
  return liveItemSchema.parse({
    id: liveItemId("owner_message", input.ref, input.quote), source: { type: "owner_message", ref: input.ref, date: iso(input.at).slice(0, 10) }, decided_at: iso(input.at),
    quote: clip(input.quote), descriptor: input.descriptor, expected: input.expected, strength: input.strength ?? "strong", why: input.why,
  });
}

/** The night step: collect what the owner decided since the policy was frozen and append it. Returns what changed. */
export async function collectAndAppend(db: Db, kv: Kv, now: number = Date.now(), policy: Policy = POLICY): Promise<{ added: number; skipped: number; total: number }> {
  return appendLiveItems(kv, collectOwnerDecisions(db, Date.parse(policy.frozen_at), now));
}
