import type { ReturnStage } from "@lane-pilot/contracts";
import type { StageReturnRecord } from "./store";

/** The longest note a return takes; what a person adds to a stage is a paragraph, not a document. */
export const NOTE_MAX = 4000;

/** The note, trimmed; null when it is empty or too long (a refusal says which). */
export function checkNote(note: unknown): { ok: true; note: string } | { ok: false; reason: string } {
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) return { ok: false, reason: "the note is empty: say what the stage did not know (--note \"…\")" };
  if (text.length > NOTE_MAX) return { ok: false, reason: `the note is ${text.length} characters, the limit is ${NOTE_MAX}; keep what the stage must know and put the rest in a file it can read` };
  return { ok: true, note: text };
}

/**
 * The notes of the returns that reached a task, as a block for the writer's brief (a first brief, a handoff or a turn). The note comes from
 * the person who owns the task: the writer follows it where it does not contradict owns_paths and never_touch.
 */
export function renderReturnNotes(records: readonly Pick<StageReturnRecord, "at" | "to" | "by" | "note">[]): string {
  if (!records.length) return "";
  return [
    "The task was returned to an earlier stage with added context from the person who owns it. Read it before you work; follow it where it does not contradict owns_paths, never_touch or the contract's checks:",
    ...records.map((row) => `<return_note stage="${row.to}" by="${row.by}" at="${new Date(row.at).toISOString()}">\n${row.note}\n</return_note>`),
  ].join("\n");
}

/** The turn a blocked writer gets in its own thread when the task is returned to it: the note, nothing else changes. */
export function returnTurnPrompt(note: string): string {
  return [
    `The task was returned to you with added context from the person who owns it; the attempt continues in this thread and worktree, and no attempt was spent:\n<return_note>\n${note}\n</return_note>`,
    "The setup rules from your first brief still hold: only owns_paths, no commits or merges, no npm install. The task contract is unchanged unless the note says otherwise.",
    "Run the verification commands, then answer with the changed paths and result.",
  ].join("\n\n");
}

const WHAT_TO_DO: Record<ReturnStage, string> = {
  discussion: "Talk it over with the owner again (what the task is for, what \"done\" means), then send the task again with lane_pilot_dispatch_writer; the old plan and every receipt of this task are stale.",
  planning: "Rework the plan and the contract with this note. If the task is still open, lane_pilot_update_task changes the contract in place; if it was stopped, send it again with lane_pilot_dispatch_writer. The plan critique and the specialist review run again on the new plan; what the PM read from the code stays valid.",
  writer: "",
};

/** What the PM reads: who returned the task, where to, the note word for word, which receipts are stale and kept, and what to do. */
export function pmReturnMessage(input: { taskId: string; to: ReturnStage; by: string; note: string; stale: ReadonlyArray<{ stage: string }>; reused: readonly string[]; stopped: string | null }): string {
  return [
    `Lane Pilot: ${input.by} returned task ${input.taskId} to ${input.to}.`,
    `Note, word for word:\n${input.note}`,
    `Stale receipts: ${input.stale.length ? input.stale.map((row) => row.stage).join(", ") : "none"}. Kept: ${input.reused.length ? input.reused.join(", ") : "none"}.`,
    input.stopped ? `The running attempt: ${input.stopped}.` : "",
    WHAT_TO_DO[input.to],
  ].filter(Boolean).join("\n");
}

/** The one line the PM gets when the task went back to its writer by itself: it only needs to know. */
export const pmWriterLine = (taskId: string, by: string, note: string, outcome: string): string =>
  `Lane Pilot: ${by} returned task ${taskId} to the writer with a note (${outcome}). The note: ${note.slice(0, 600)}${note.length > 600 ? "…" : ""}`;
