import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ServerCore } from "../../contracts/server";
import { journalAppend, laneOwnedMetadata, presenceHold, readPresence, type JournalRow, type Presence } from "../logic";

const PRESENCE_KV = "owner-presence";
/** One row per owner's own thread per day, kept ninety days: how much work happens outside the daemon. */
const JOURNAL_KV = "owner-presence:journal";

type Note = (mark: Presence, extra?: { threadId?: string }) => void | Promise<void>;
let noteOwner: Note | null = null;

/** The live store. One plugin process holds the marks; a reload reads them back from plugin kv. */
export function bindOwnerPresence(note: Note | null): void {
  noteOwner = note;
}

/**
 * A user message in a thread Lane Pilot did not start marks that thread's provider. Agent sends, retries from another
 * thread, and any thread with a lane role or marker do not. (2026-10-29 claude-guard)
 */
export async function observeOwnerDispatch(bb: Pick<BbPluginApi, "sdk">, ctx: {
  initiator?: string | null;
  senderThreadId?: string | null;
  thread: { id: string };
  requestedExecution: { providerId: string };
  host?: { id?: string; name?: string | null } | null;
}): Promise<void> {
  if (!noteOwner || ctx.initiator !== "user" || ctx.senderThreadId) return;
  const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: ctx.thread.id }).catch(() => null);
  if (laneOwnedMetadata(metadata)) return;
  const providerId = ctx.requestedExecution.providerId;
  if (!providerId) return;
  await noteOwner({
    providerId,
    at: Date.now(),
    hostId: ctx.host?.id || "bb",
    host: ctx.host?.name ?? null,
  }, { threadId: ctx.thread.id });
}

function marksText(rows: readonly Presence[]): string {
  const body: Record<string, { at: number; host: string | null }> = {};
  for (const row of rows) body[row.providerId] = { at: row.at, host: row.host };
  return JSON.stringify(body);
}

/**
 * Marks live in memory and in plugin kv. The file `~/.agents/state/owner-presence.json` is not read: each sweep was a
 * host call per machine, and Claude Lane's hook is what wrote that file. (2026-10-29 claude-guard)
 */
export function createOwnerPresence(ctx: Pick<ServerCore, "bb" | "log">) {
  let presence: Presence[] = [];
  let journal: JournalRow[] = [];
  const kv = ctx.bb.storage.kv;

  function replace(next: Presence[]) {
    presence = next;
  }

  async function note(mark: Presence, extra?: { threadId?: string }) {
    const memory = marksText(presence);
    replace(readPresence([
      { hostId: "memory", text: memory },
      { hostId: mark.hostId, text: JSON.stringify({ [mark.providerId]: { at: mark.at, host: mark.host } }) },
    ]));
    await kv.set(PRESENCE_KV, marksText(presence)).catch((cause: unknown) => {
      ctx.log(`owner presence save failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    if (extra?.threadId) {
      journal = journalAppend(journal, { threadId: extra.threadId, providerId: mark.providerId, hostId: mark.hostId, at: mark.at }, Date.now());
      await kv.set(JOURNAL_KV, JSON.stringify(journal)).catch((cause: unknown) => {
        ctx.log(`owner presence journal save failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    }
  }

  bindOwnerPresence(note);

  async function sweep(): Promise<Presence[]> {
    const saved = await kv.get(PRESENCE_KV);
    if (typeof saved === "string" && saved) {
      replace(readPresence([
        { hostId: "memory", text: marksText(presence) },
        { hostId: "bb", text: saved },
      ]));
    }
    const savedJournal = await kv.get(JOURNAL_KV);
    if (typeof savedJournal === "string" && savedJournal) {
      try { const rows = JSON.parse(savedJournal) as unknown; if (Array.isArray(rows)) journal = rows.filter((row): row is JournalRow => !!row && typeof row.day === "string" && typeof row.threadId === "string"); } catch { /* a corrupt journal starts empty */ }
    }
    return presence;
  }

  return { ownerPresence: { sweep, holds: (providerId: string, now = Date.now()) => presenceHold(providerId, presence, now), current: () => presence, journal: () => journal } };
}
export type OwnerPresenceApi = ReturnType<typeof createOwnerPresence>["ownerPresence"];

export function mountOwnerPresence(ctx: ServerCore, api: OwnerPresenceApi): void {
  void api.sweep().catch((cause: unknown) => ctx.log(`owner presence load failed: ${cause instanceof Error ? cause.message : String(cause)}`));
}
