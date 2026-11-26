import type { ServerCore } from "../../../contracts/server";
import type { JournalRow } from "../../models/presence";

const PRESENCE_KV = "owner-presence";
/** One row per owner's own thread per day, kept ninety days: how much work happens outside the daemon. */
const JOURNAL_KV = "owner-presence:journal";

export type PresenceKvStore = Pick<ServerCore["bb"]["storage"]["kv"], "get" | "set">;

/** Reads stored presence marks JSON from plugin KV, or null when empty. */
export async function loadPresenceMarks(kv: PresenceKvStore): Promise<string | null> {
  const saved = await kv.get(PRESENCE_KV);
  return typeof saved === "string" && saved ? saved : null;
}

/** Persists serialized presence marks JSON to plugin KV. */
export async function savePresenceMarks(kv: PresenceKvStore, marksJson: string): Promise<void> {
  await kv.set(PRESENCE_KV, marksJson);
}

/** Reads stored terminal journal rows from plugin KV; corrupt JSON starts empty. */
export async function loadPresenceJournal(kv: PresenceKvStore): Promise<JournalRow[]> {
  const saved = await kv.get(JOURNAL_KV);
  if (typeof saved !== "string" || !saved) return [];
  try {
    const rows = JSON.parse(saved) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is JournalRow => !!row && typeof row.day === "string" && typeof row.threadId === "string");
  } catch {
    /* a corrupt journal starts empty */
    return [];
  }
}

/** Persists terminal journal rows to plugin KV. */
export async function savePresenceJournal(kv: PresenceKvStore, rows: readonly JournalRow[]): Promise<void> {
  await kv.set(JOURNAL_KV, JSON.stringify(rows));
}
