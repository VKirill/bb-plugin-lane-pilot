import type { ServerCore } from "../../../contracts/server";
import { journalAppend, presenceHold, readPresence, type JournalRow, type Presence } from "../../models/presence";
import { loadPresenceJournal, loadPresenceMarks, savePresenceJournal, savePresenceMarks } from "../repositories/presence-repository";

type Note = (mark: Presence, extra?: { threadId?: string }) => void | Promise<void>;
let noteOwner: Note | null = null;

/** The live store. One plugin process holds the marks; a reload reads them back from plugin kv. */
export function bindOwnerPresence(note: Note | null): void {
  noteOwner = note;
}

/** Whether a live presence store is currently bound in this process. */
export function isOwnerPresenceBound(): boolean {
  return noteOwner !== null;
}

/** Forwards an observed owner dispatch mark to the bound live presence store. */
export async function recordOwnerPresence(mark: Presence, extra?: { threadId?: string }): Promise<void> {
  if (!noteOwner) return;
  await noteOwner(mark, extra);
}

function marksText(rows: readonly Presence[]): string {
  const body: Record<string, { at: number; host: string | null }> = {};
  for (const row of rows) body[row.providerId] = { at: row.at, host: row.host };
  return JSON.stringify(body);
}

/**
 * Marks live in memory and in plugin kv. The file `~/.agents/state/owner-presence.json` is not read: each sweep was a
 * host call per machine, and the legacy hook is what wrote that file. (2026-10-29 claude-guard)
 */
export function createOwnerPresence(ctx: Pick<ServerCore, "bb" | "log">) {
  let presence: Presence[] = [];
  let journal: JournalRow[] = [];
  const kv = ctx.bb.storage.kv;

  function replace(next: Presence[]) {
    presence = next;
  }

  let journalLoad: Promise<void> | null = null;
  // Once, lazily: the first caller (a message or the sweep) reads the stored rows, the others wait for it; a failed read is tried again next time.
  function loadJournal(): Promise<void> {
    journalLoad ??= (async () => {
      journal = await loadPresenceJournal(kv);
    })().catch((cause: unknown) => { journalLoad = null; throw cause; });
    return journalLoad;
  }

  async function note(mark: Presence, extra?: { threadId?: string }) {
    const memory = marksText(presence);
    replace(readPresence([
      { hostId: "memory", text: memory },
      { hostId: mark.hostId, text: JSON.stringify({ [mark.providerId]: { at: mark.at, host: mark.host } }) },
    ]));
    await savePresenceMarks(kv, marksText(presence)).catch((cause: unknown) => {
      ctx.log(`owner presence save failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    if (extra?.threadId) {
      try {
        // The stored journal is read before the first write: a message that beats the startup sweep must not replace ninety days with one row.
        await loadJournal();
        const next = journalAppend(journal, { threadId: extra.threadId, providerId: mark.providerId, hostId: mark.hostId, at: mark.at }, Date.now());
        const added = next.length > 0 && !journal.includes(next[next.length - 1]!);
        journal = next;
        if (added) await savePresenceJournal(kv, journal);
      } catch (cause) {
        ctx.log(`owner presence journal save failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  bindOwnerPresence(note);

  async function sweep(): Promise<Presence[]> {
    const saved = await loadPresenceMarks(kv);
    if (saved) {
      replace(readPresence([
        { hostId: "memory", text: marksText(presence) },
        { hostId: "bb", text: saved },
      ]));
    }
    await loadJournal().catch(() => undefined);
    return presence;
  }

  return { ownerPresence: { sweep, holds: (providerId: string, now = Date.now()) => presenceHold(providerId, presence, now), current: () => presence, journal: () => journal } };
}
export type OwnerPresenceApi = ReturnType<typeof createOwnerPresence>["ownerPresence"];
