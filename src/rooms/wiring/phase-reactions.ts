import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { DesignJournalLine } from "@lane-pilot/contracts";
import type { LanePilotDatabase } from "../storage";
import { storeMemoryRecords } from "../storage";
import { closeOwnerItem, closeOwnerItemsByPrefix, postOwnerItem } from "../owner-waiting";
import { answerPhaseWord, askPhaseWord } from "../lead";
import { critiqueProblems, roleLine } from "../design-eval";
import type { PhaseReactions } from "../phase/server";

export const DESIGN_JOURNAL = "lp.design.journal";
export const ROLE_LINES = "lp.role.lines";

/** The default bindings: the plugin's own rooms. Moved to the composition root, the phase room imports none of them. */
export function createPhaseReactions(db: LanePilotDatabase, bb: BbPluginApi): PhaseReactions {
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
    critiqueProblems, roleLine,
  };
}
