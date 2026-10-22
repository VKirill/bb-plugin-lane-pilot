import {
  dropMemoryIndexes, findConflicts, getConflict, hideRecord, holdConflict, listConflicts, markSettled, setDeferral,
  type ConflictNote, type ConflictResolution, type ConflictRow,
} from "@lane-pilot/memory-core";
import type { DeferralApi } from "../../deferral/server";
import type { LanePilotDatabase } from "../../storage";

/**
 * The register of memory conflicts as a service (SMA block 4, P2-7). After every write of memory the new notes are compared with the
 * active ones of their project; two that disagree are held (both leave every reader, `conflict-store.ts`) and an entry of kind
 * `memory_conflict` opens in the deferral register. That entry is `needs_owner_term`: it shows in the morning list, and only the
 * owner's message gives it a date (`bb lane-pilot defer <dfr_id> --owner-msg …`); a date that passes turns the deploy drill red like any
 * other deferral. Settling it needs a person's decision and a line of evidence, and closes the entry. A conflict whose note is gone
 * (replaced, evicted, expired) settles itself as `moot`.
 */
export type ConflictDeps = { db: LanePilotDatabase; deferrals: () => DeferralApi; log?: (line: string) => void; now?: () => number };
/** More than this many held conflicts in one project means the heuristics are misfiring: stop opening entries and say so. */
export const MAX_HELD_PER_PROJECT = 25;

type NoteRow = { id: string; audience: string; personal_bot: string; content: string; concepts_json: string; created_at: number };

const quote = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 70);

export function createMemoryConflicts(deps: ConflictDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const unindex = (projectId: string, id: string) => dropMemoryIndexes(db, projectId, id);

  function detect(projectId: string, only?: ReadonlySet<string>): ConflictRow[] {
    const rows = db.prepare("SELECT id,audience,personal_bot,content,concepts_json,created_at FROM lane_pilot_memory WHERE project_id=? AND status='active'").all(projectId) as NoteRow[];
    const groups = new Map<string, Array<ConflictNote & { personalBot: string }>>();
    for (const row of rows) {
      const concepts = JSON.parse(row.concepts_json) as string[];
      if (concepts.includes("rule")) continue;
      const key = `${row.audience}|${row.personal_bot}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push({ id: row.id, content: row.content, concepts, createdAt: row.created_at, personalBot: row.personal_bot });
    }
    const opened: ConflictRow[] = [];
    let held = listConflicts(db, { projectId, state: "held" }).length;
    for (const notes of groups.values()) {
      for (const conflict of findConflicts(notes, only)) {
        if (held >= MAX_HELD_PER_PROJECT) { deps.log?.(`memory conflicts: ${projectId} already holds ${held}; the rest are not opened (check the heuristics)`); return opened; }
        const row = holdConflict(db, { projectId, personalBot: notes[0]!.personalBot, conflict, now: now() });
        if (!row) continue;
        held += 1;
        const entry = deps.deferrals().open({ id: `dfr_${row.id}`, kind: "memory_conflict", area: "memory", projectId,
          what: `Memory notes disagree (${conflict.kind}, ${quote(conflict.subject)}): «${quote(row.evidenceA)}» against «${quote(row.evidenceB)}». Both are held out of every brief until settled: bb lane-pilot memory-conflict-settle ${row.id} --keep a|b|both|none --evidence <why>` });
        setDeferral(db, row.id, entry.id);
        opened.push(getConflict(db, row.id)!);
      }
    }
    if (opened.length) deps.log?.(`memory conflicts: ${opened.length} held in ${projectId}`);
    return opened;
  }

  const closeEntry = (row: ConflictRow, evidence: string) => {
    if (!row.deferralId) return;
    try { deps.deferrals().close({ id: row.deferralId, evidence }); } catch { /* an entry closed by hand stays closed */ }
  };

  /** Conflicts whose note is no longer active settle themselves: the disagreement is gone with the note. */
  function sweepMoot(projectId?: string): ConflictRow[] {
    const settled: ConflictRow[] = [];
    for (const row of listConflicts(db, { projectId, state: "held" })) {
      const active = (id: string) => Boolean(db.prepare("SELECT 1 FROM lane_pilot_memory WHERE project_id=? AND id=? AND status='active'").get(row.projectId, id));
      if (active(row.noteA) && active(row.noteB)) continue;
      const evidence = `moot: ${active(row.noteA) ? row.noteB.slice(0, 10) : row.noteA.slice(0, 10)} is no longer an active note (replaced, evicted or expired)`;
      if (markSettled(db, row.id, "moot", evidence, now())) { closeEntry(row, evidence); settled.push(getConflict(db, row.id)!); }
    }
    return settled;
  }

  function settle(input: { id: string; keep: "a" | "b" | "both" | "none"; evidence: string }): ConflictRow {
    const row = getConflict(db, input.id.trim());
    if (!row) throw new Error(`no memory conflict ${input.id}`);
    if (row.state === "settled") throw new Error(`${row.id} is already settled (${row.resolution}: ${row.settledBy ?? "no evidence"})`);
    const evidence = input.evidence.trim();
    if (evidence.length < 8) throw new Error("--evidence must say why: which note is true and how you checked");
    const resolution: ConflictResolution = ({ a: "keep_a", b: "keep_b", both: "keep_both", none: "drop_both" } as const)[input.keep];
    db.transaction(() => {
      const winner = resolution === "keep_a" ? row.noteA : resolution === "keep_b" ? row.noteB : null;
      const loser = resolution === "keep_a" ? row.noteB : resolution === "keep_b" ? row.noteA : null;
      if (loser && winner) hideRecord(db, row.projectId, loser, "superseded", winner, unindex);
      if (resolution === "drop_both") for (const id of [row.noteA, row.noteB]) hideRecord(db, row.projectId, id, "expired", null, unindex);
      if (!markSettled(db, row.id, resolution, evidence.slice(0, 1_000), now())) throw new Error(`${row.id} was settled meanwhile`);
    }).immediate();
    closeEntry(row, `${resolution}: ${evidence}`.slice(0, 1_900));
    return getConflict(db, row.id)!;
  }

  function list(filter: { projectId?: string | undefined; state?: "held" | "settled" | undefined } = {}): ConflictRow[] {
    sweepMoot(filter.projectId);
    return listConflicts(db, filter);
  }

  return { detect, list, settle, sweepMoot };
}
export type MemoryConflictsApi = ReturnType<typeof createMemoryConflicts>;
