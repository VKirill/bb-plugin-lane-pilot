import { dropMemoryIndexes, hideRecord, noteRefutedByCheck, recordMemoryAccepted } from "@lane-pilot/memory-core";
import { attemptTraceContext, onAttemptChanged, type LanePilotDatabase, type ReasoningTrace } from "../../storage";

/** A check that quotes a note from this attempt's brief expires that note. A note the brief did not carry, and a failure that does not quote the note, stay. Never fails the transition. */
function refuteMemoryOfAttempt(db: LanePilotDatabase, attemptId: string, failureText: string): void {
  try {
    const row = attemptTraceContext(db, attemptId);
    const picked = row ? (JSON.parse(row.trace) as ReasoningTrace).dispatchContext?.memoryPicked : undefined;
    if (!row || !Array.isArray(picked)) return;
    for (const id of picked) {
      if (typeof id !== "string") continue;
      const note = db.prepare("SELECT content FROM lane_pilot_memory WHERE project_id=? AND id=? AND status='active'").get(row.projectId, id) as { content: string } | undefined;
      if (note && noteRefutedByCheck(note.content, failureText)) hideRecord(db, row.projectId, id, "expired", null, (projectId, memoryId) => dropMemoryIndexes(db, projectId, memoryId), "refuted");
    }
  } catch { /* a refutation never fails the transition */ }
}

/** An accepted attempt credits the memory notes its brief carried, so the notes that serve briefs well rank higher. Never fails the transition. */
function creditMemoryOfAttempt(db: LanePilotDatabase, attemptId: string): void {
  try {
    const row = attemptTraceContext(db, attemptId);
    const picked = row ? (JSON.parse(row.trace) as ReasoningTrace).dispatchContext?.memoryPicked : undefined;
    if (row && Array.isArray(picked) && picked.length) recordMemoryAccepted(db, row.projectId, picked.filter((id): id is string => typeof id === "string"));
  } catch { /* the counters are a ranking hint, not a gate */ }
}

const wired = new WeakSet<LanePilotDatabase>();
/**
 * The memory side of an attempt's outcome, subscribed to the storage room's change signal: storage emits the move,
 * the memory room owns what it means for the notes the brief carried. Idempotent per database — the composition root
 * (server.ts through createMemoryStage, plugin-db for tests) may wire it once.
 */
export function wireMemoryAttemptEffects(db: LanePilotDatabase): void {
  if (wired.has(db)) return;
  wired.add(db);
  onAttemptChanged(db, (attemptId, toState, reason) => {
    if (toState === "accepted") creditMemoryOfAttempt(db, attemptId);
    if (toState === "validation_failed" && reason) refuteMemoryOfAttempt(db, attemptId, reason);
  });
}
