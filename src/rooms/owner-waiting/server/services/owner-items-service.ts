import type Database from "better-sqlite3";
import { isOwnerReason } from "@lane-pilot/contracts";
import { countTermedDeferrals } from "../../../deferral/server";
import { listFailedAttemptsSince, listOpenAttempts } from "../../../storage";
import {
  FACT_KINDS,
  NOW_CAP,
  OVERNIGHT_WINDOW_MS,
  OWNER_FACT_TTL_MS,
  OWNER_NOTE_TTL_MS,
  REASON_RANK,
  SOURCE_ORDER,
  callReason,
  defaultWakeForReason,
  isSandboxProject,
  parseJson,
  withReadButton,
  type Answered,
  type Overnight,
  type OwnerAction,
  type OwnerEvidence,
  type OwnerItem,
  type OwnerItemCreatedEvent,
  type OwnerWaiting,
  type PostOwnerItem,
} from "../../models/owner-item";
import {
  DECISION_DAY_KEY,
  DECISION_DAY_KEYS_KEY,
  MAX_DECISION_CAP,
  localDateKey,
} from "../../models/push-config";
import { loadPushConfig, readOwnerConfigKey, writeOwnerConfigKey } from "./owner-config-service";
import {
  closeOwnerItem,
  closeOwnerItemsByPrefix,
  countAcceptedAttemptsSince,
  countOpenInboxItems,
  countOpenOwnerItems,
  decidedOwnerItem,
  hasOpenOwnerItem,
  listClosedByCountsSince,
  listOpenItemsForSweep,
  listOpenOwnerItemKeys,
  listOpenOwnerItemRows,
  listOpenOwnerItems,
  ownerAnsweredItem,
  ownerItemPrefixCount,
  tableExists,
  upsertOwnerItem,
  type OwnerItemSweep,
} from "../repositories/owner-item-repository";

export {
  closeOwnerItem,
  closeOwnerItemsByPrefix,
  countOpenOwnerItems,
  decidedOwnerItem,
  hasOpenOwnerItem,
  listOpenOwnerItemKeys,
  listOpenOwnerItems,
  ownerAnsweredItem,
  ownerItemPrefixCount,
  tableExists,
  type OwnerItemSweep,
};

type Db = Pick<Database.Database, "prepare">;

const ownerItemCreatedListeners = new Set<(event: OwnerItemCreatedEvent) => void>();

/** Subscribes to newly opened or reopened owner items after postOwnerItem commits a change. */
export function onOwnerItemCreated(fn: (event: OwnerItemCreatedEvent) => void): () => void {
  ownerItemCreatedListeners.add(fn);
  return () => ownerItemCreatedListeners.delete(fn);
}

/** The night loop's door: an open waiting with a stable `key`; posting the same key again changes nothing (one waiting, one row). */
export function postOwnerItem(db: Db, item: PostOwnerItem, now: number = Date.now(), log?: (message: string) => void): { created: boolean } {
  if (!item.key.trim() || !item.what.trim() || !item.why.trim()) throw new Error("an owner item needs a key, what and why");
  if (!isOwnerReason((item as { reason?: unknown }).reason)) {
    const warn = log ?? console.warn;
    warn(`owner item refused source=${item.source} kind=${item.kind} (no reason)`);
    return { created: false };
  }
  if (isSandboxProject(item.projectId)) return { created: false };
  const created = upsertOwnerItem(db, item, now);
  if (created) {
    const event: OwnerItemCreatedEvent = {
      key: item.key,
      projectId: item.projectId ?? null,
      kind: item.kind,
      wake: item.wake ?? defaultWakeForReason(item.reason),
      now,
    };
    for (const listener of ownerItemCreatedListeners) {
      try { listener(event); } catch { /* listener errors must not abort item persistence */ }
    }
  }
  return { created };
}

/**
 * The list shows what still waits; a row whose question went away is closed here, on every read (SWE-2 F-004..F-006, Gemini F-006:
 * «an inbox where rows are born and never die»). Two cases the posters cannot see themselves:
 *  - a row whose owner says it is gone (`sweeps`: the writer's question, a red run goal, a phase's word, a failed schedule run);
 *  - a row with no action after its term: a fact after three days, anything else without buttons after seven.
 */
export function sweepOwnerItems(db: Db, now: number = Date.now(), sweeps: readonly OwnerItemSweep[] = []): number {
  const rows = listOpenItemsForSweep(db);
  if (!rows.length) return 0;
  let closed = 0;
  const close = (key: string, by: string) => { closed += closeOwnerItem(db, key, by, now) ? 1 : 0; };
  for (const row of rows) {
    const gone = sweeps.map((sweep) => sweep(db, row)).find((reason) => reason !== null);
    if (gone) { close(row.key, gone); continue; }
    // A failure row keeps its buttons, but a fact three days old is no longer news: it leaves with the other facts.
    if ((row.kind === "schedule_failed" || parseJson<OwnerAction[]>(row.actions_json, []).length === 0) && now - row.created_at > (FACT_KINDS.has(row.kind) ? OWNER_FACT_TTL_MS : OWNER_NOTE_TTL_MS)) {
      close(row.key, "janitor:term");
    }
  }
  return closed;
}

export function overnight(db: Db, now: number = Date.now(), windowMs: number = OVERNIGHT_WINDOW_MS): Overnight {
  const since = now - windowMs;
  const red = listFailedAttemptsSince(db as Database.Database, since)
    .reduce<Overnight["red"]>((groups, row) => {
      const group = groups.find((item) => item.state === row.state) ?? groups[groups.push({ state: row.state, count: 0, attempts: [] }) - 1]!;
      group.count += 1;
      if (group.attempts.length < 5) group.attempts.push(row.id);
      return groups;
    }, []);
  return {
    windowMs,
    red,
    accepted: countAcceptedAttemptsSince(db, since),
    rulesAdopted: 0,
    rulesConfirmed: 0,
  };
}

function inbox(db: Db): OwnerItem[] {
  return listOpenOwnerItemRows(db)
    .filter((row) => !isSandboxProject(row.project_id))
    .map((row) => ({
      key: row.key,
      source: row.source,
      kind: row.kind,
      projectId: row.project_id,
      what: row.what,
      why: row.why,
      since: row.created_at,
      wake: row.wake === 1,
      tier: "later",
      evidence: parseJson<OwnerEvidence[]>(row.evidence_json, []),
      actions: withReadButton(row.key, parseJson<OwnerAction[]>(row.actions_json, [])),
    }));
}

export type CollectOwnerWaitingOptions = {
  windowMs?: number;
  decisionCap?: number;
  timezone?: string;
  log?: (message: string) => void;
};

function readDecisionBudgetState(db: Db, day: string): { count: number; keys: Set<string>; rawDay: string | null; rawKeys: string | null } {
  const rawDay = readOwnerConfigKey(db as never, DECISION_DAY_KEY);
  const rawKeys = readOwnerConfigKey(db as never, DECISION_DAY_KEYS_KEY);
  let count = 0;
  if (rawDay) {
    const colon = rawDay.lastIndexOf(":");
    if (colon > 0 && rawDay.slice(0, colon) === day) {
      const parsed = Number(rawDay.slice(colon + 1));
      if (Number.isSafeInteger(parsed) && parsed >= 0) count = parsed;
    }
  }
  const keys = new Set<string>();
  if (rawKeys) {
    const parsed = parseJson<{ day?: unknown; keys?: unknown }>(rawKeys, {});
    if (parsed.day === day && Array.isArray(parsed.keys)) {
      for (const k of parsed.keys) if (typeof k === "string") keys.add(k);
    }
  }
  if (keys.size > count) count = keys.size;
  return { count, keys, rawDay, rawKeys };
}

export function collectOwnerWaiting(
  db: Db,
  now: number = Date.now(),
  sweeps: readonly OwnerItemSweep[] = [],
  optionsOrWindowMs: number | CollectOwnerWaitingOptions = OVERNIGHT_WINDOW_MS,
): OwnerWaiting {
  const opts = typeof optionsOrWindowMs === "number" ? { windowMs: optionsOrWindowMs } : optionsOrWindowMs;
  const windowMs = opts.windowMs ?? OVERNIGHT_WINDOW_MS;
  sweepOwnerItems(db, now, sweeps);
  const items = [...inbox(db)];
  const rank = (item: OwnerItem) => { const at = SOURCE_ORDER.indexOf(item.source); return at < 0 ? SOURCE_ORDER.indexOf("night") : at; };
  // The cost of putting a row off first, a row that would push before one that would not, then the sources' order and age; the first NOW_CAP are «now».
  items.sort((a, b) => REASON_RANK[callReason(a.kind)] - REASON_RANK[callReason(b.kind)] || Number(b.wake) - Number(a.wake) || rank(a) - rank(b) || a.since - b.since || a.key.localeCompare(b.key));

  const config = loadPushConfig(db);
  const rawCap = opts.decisionCap ?? config.decisionCap;
  const cap = Number.isFinite(rawCap) ? Math.max(0, Math.min(MAX_DECISION_CAP, Math.floor(rawCap))) : config.decisionCap;
  const timezone = opts.timezone ?? config.timezone;
  const day = localDateKey(now, timezone);
  const budget = readDecisionBudgetState(db, day);

  let nowSlots = 0;
  let admittedDecisions = 0;
  let decisionsToday = budget.count;
  let deferred = 0;

  for (const item of items) {
    const reason = callReason(item.kind);
    if (reason !== "decision") {
      item.tier = nowSlots < NOW_CAP ? "now" : "later";
      if (item.tier === "now") nowSlots += 1;
      continue;
    }
    if (cap === 0) {
      item.tier = "later";
      item.wake = false;
      item.desk = true;
      deferred += 1;
      continue;
    }
    if (budget.keys.has(item.key)) {
      if (admittedDecisions < cap && nowSlots < NOW_CAP) {
        item.tier = "now";
        nowSlots += 1;
        admittedDecisions += 1;
      } else if (admittedDecisions >= cap) {
        item.tier = "later";
        item.wake = false;
        item.desk = true;
        deferred += 1;
      } else {
        item.tier = "later";
      }
      continue;
    }
    if (item.wake) {
      if (decisionsToday < cap && nowSlots < NOW_CAP) {
        item.tier = "now";
        nowSlots += 1;
        decisionsToday += 1;
        admittedDecisions += 1;
        budget.keys.add(item.key);
      } else if (decisionsToday >= cap) {
        item.tier = "later";
        item.wake = false;
        item.desk = true;
        deferred += 1;
      } else {
        item.tier = "later";
      }
      continue;
    }
    if (decisionsToday >= cap) {
      item.tier = "later";
      item.wake = false;
      item.desk = true;
      deferred += 1;
    } else if (nowSlots < NOW_CAP) {
      item.tier = "now";
      nowSlots += 1;
    } else {
      item.tier = "later";
    }
  }

  if (tableExists(db, "lane_pilot_owner_config")) {
    const nextDayValue = `${day}:${decisionsToday}`;
    const nextKeysValue = JSON.stringify({ day, keys: [...budget.keys] });
    if (budget.rawDay !== nextDayValue) writeOwnerConfigKey(db as never, DECISION_DAY_KEY, nextDayValue, now);
    if (budget.rawKeys !== nextKeysValue) writeOwnerConfigKey(db as never, DECISION_DAY_KEYS_KEY, nextKeysValue, now);
  }
  opts.log?.(`attention budget decisions_today=${decisionsToday} cap=${cap} deferred=${deferred}`);

  const counts: Record<string, number> = {};
  for (const item of items) counts[item.source] = (counts[item.source] ?? 0) + 1;
  const attention = {
    cap,
    shown: decisionsToday,
    remaining: Math.max(0, cap - decisionsToday),
    day,
  };
  return { generatedAt: now, items, counts, overnight: overnight(db, now, windowMs), now: nowSlots, answered: answered(db, now), attention };
}

/** Who closed the rows of the last 7 days (the answer statistics the research asked for: a reflex inbox shows as «janitor» and «agent», never «owner»). */
export function answered(db: Db, now: number = Date.now()): Answered {
  const out: Answered = { owner: 0, agent: 0, lead: 0, janitor: 0 };
  const rows = listClosedByCountsSince(db, now - 7 * 24 * 3_600_000);
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
  return {
    // Only a human term can be overdue (deferral/store.ts HUMAN_TERM_SQL): an entry with the code's or an agent's term is «open, no term».
    overdue: countTermedDeferrals(db, { states: ["open", "overdue"], dueBefore: now }),
    open: countTermedDeferrals(db, { states: ["open"], dueAtLeast: now }),
    inbox: countOpenInboxItems(db),
  };
}

export function hasOpenAttempts(db: Db): boolean {
  return listOpenAttempts(db as Database.Database).length > 0;
}
