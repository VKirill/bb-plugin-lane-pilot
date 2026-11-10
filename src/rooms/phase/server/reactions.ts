import type { StoreMemoryInput } from "@lane-pilot/memory-core";
import type { DesignCritiqueCase, DesignJournalLine, DrawingCritique } from "@lane-pilot/contracts";

/**
 * The «Ждут владельца» row the phase posts — owner-waiting's PostOwnerItem shape kept structural, so the room
 * imports none of the rooms it reports to (the composition root binds the real functions).
 */
type OwnerEvidenceLine = { kind: "attempt" | "task" | "run" | "file" | "note" | "message" | "command" | "text"; ref: string; label?: string };
type OwnerActionLine = { id: string; label: string; cli: string; rpc?: { method: string; input: Record<string, unknown> }; needsOwnerMessage?: boolean; hint?: string };
export type OwnerItemDraft = { key: string; source: string; kind: string; what: string; why: string; projectId?: string | null; wake?: boolean; evidence?: OwnerEvidenceLine[]; actions?: OwnerActionLine[] };

/** The phase fields the lead's word journal reads — lead's WordPhase shape, structural for the same reason. */
export type PhaseWordSubject = { id: string; projectId: string; runId: string | null; title: string; goal: string; stage: string };

/**
 * The phase driver's needs on other rooms, handed to it as callbacks. The driver decides what the phase needs (a lesson in
 * memory, a row on «Ждут владельца», the owner's word asked, a line in the design journal, the design critique check);
 * the composition root binds these to the rooms that carry them, so the phase machine itself imports none of them.
 */
export type PhaseReactions = {
  /** The memory door: a lesson of a closed phase, or a refusal reason when the door throws. */
  storeMemoryRecord(input: StoreMemoryInput): void;
  /** A row on «Ждут владельца» (the phase's turn, its lesson draft). */
  postOwnerItem(item: OwnerItemDraft, now?: number): { created: boolean };
  closeOwnerItem(key: string, by: string, now?: number): boolean;
  closeOwnerItemsByPrefix(prefix: string, by: string, now?: number): number;
  /** The lead's journal: the phase's turn asked, and the owner's word on it answered. */
  askPhaseWord(phase: PhaseWordSubject, turn: string, wave: number | undefined, ask: string): void;
  answerPhaseWord(phaseId: string, turn: string, wave: number | undefined, decision: "yes" | "no", text: string, by: string): void;
  /** The design measurement journal and the designer's role lines. */
  journalDrawing(line: DesignJournalLine): Promise<void>;
  noteDesignWord(phaseId: string, decision: "yes" | "no"): Promise<void>;
  addRoleLine(projectId: string, role: string, line: string): Promise<void>;
  /** A critique's set_case continuation: stored for later checks of the judge (SMA k_lib_dfeedback). */
  storeCritiqueCase(entry: DesignCritiqueCase): Promise<void>;
  /** design-eval's pure rules the drawing step runs: the critique form check and the designer's dated role line. */
  critiqueProblems(critique: DrawingCritique): string[];
  roleLine(lesson: string): string;
};
