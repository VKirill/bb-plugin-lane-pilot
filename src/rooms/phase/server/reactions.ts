import type { ServerCore } from "../../core/server";
import { storeMemoryRecords } from "../../storage";
import { closeOwnerItem, closeOwnerItemsByPrefix, postOwnerItem } from "../../owner-waiting";
import { answerPhaseWord, askPhaseWord } from "../../lead";
import type { DesignJournalLine } from "../../design-eval";

export const DESIGN_JOURNAL = "lp.design.journal";
export const ROLE_LINES = "lp.role.lines";

/**
 * The phase driver's side effects on other rooms, handed to it as callbacks. The driver decides what the phase needs (a lesson in
 * memory, a row on «Ждут владельца», the owner's word asked, a line in the design journal); the composition root binds these to the
 * rooms that carry them, so the phase machine itself imports none of them.
 */
export type PhaseReactions = {
  /** The memory door: a lesson of a closed phase, or a refusal reason when the door throws. */
  storeMemoryRecord(input: Parameters<typeof storeMemoryRecords>[1]): void;
  /** A row on «Ждут владельца» (the phase's turn, its lesson draft). */
  postOwnerItem(item: Parameters<typeof postOwnerItem>[1], now?: number): { created: boolean };
  closeOwnerItem(key: string, by: string, now?: number): boolean;
  closeOwnerItemsByPrefix(prefix: string, by: string, now?: number): number;
  /** The lead's journal: the phase's turn asked, and the owner's word on it answered. */
  askPhaseWord(phase: Parameters<typeof askPhaseWord>[1], turn: string, wave: number | undefined, ask: string): void;
  answerPhaseWord(phaseId: string, turn: string, wave: number | undefined, decision: "yes" | "no", text: string, by: string): void;
  /** The design measurement journal and the designer's role lines. */
  journalDrawing(line: DesignJournalLine): Promise<void>;
  noteDesignWord(phaseId: string, decision: "yes" | "no"): Promise<void>;
  addRoleLine(projectId: string, role: string, line: string): Promise<void>;
};

/** The default bindings: the plugin's own rooms. Moved to the composition root, the phase room imports none of them. */
export function createPhaseReactions(db: ServerCore["db"], bb: ServerCore["bb"]): PhaseReactions {
  const journalDrawing = async (line: DesignJournalLine): Promise<void> => {
    const lines = ((await bb.storage.kv.get(DESIGN_JOURNAL).catch(() => null)) as DesignJournalLine[] | null) ?? [];
    await bb.storage.kv.set(DESIGN_JOURNAL, [...lines, line].slice(-2000) as never);
  };
  const noteDesignWord = async (phaseId: string, decision: "yes" | "no"): Promise<void> => {
    const lines = ((await bb.storage.kv.get(DESIGN_JOURNAL).catch(() => null)) as DesignJournalLine[] | null) ?? [];
    const last = [...lines].reverse().find((line) => line.phaseId === phaseId);
    if (!last) return;
    last.ownerWord = decision;
    if (decision === "no") last.firstPass = false;
    await bb.storage.kv.set(DESIGN_JOURNAL, lines as never);
  };
  const addRoleLine = async (projectId: string, role: string, line: string): Promise<void> => {
    const key = `${ROLE_LINES}:${projectId}:${role}`;
    const lines = ((await bb.storage.kv.get(key).catch(() => null)) as string[] | null) ?? [];
    if (!lines.includes(line)) await bb.storage.kv.set(key, [...lines, line].slice(-30) as never);
  };
  return {
    storeMemoryRecord: (input) => { storeMemoryRecords(db, input); },
    postOwnerItem: (item, now) => postOwnerItem(db, item, now),
    closeOwnerItem: (key, by, now) => closeOwnerItem(db, key, by, now),
    closeOwnerItemsByPrefix: (prefix, by, now) => closeOwnerItemsByPrefix(db, prefix, by, now),
    askPhaseWord: (phase, turn, wave, ask) => { askPhaseWord(db, phase, turn, wave, ask); },
    answerPhaseWord: (phaseId, turn, wave, decision, text, by) => { answerPhaseWord(db, phaseId, turn, wave, decision, text, by); },
    journalDrawing, noteDesignWord, addRoleLine,
  };
}
