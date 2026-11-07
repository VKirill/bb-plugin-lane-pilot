import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { bestEffort } from "@lane-pilot/kit";
import type { DesignJournalLine } from "@lane-pilot/contracts";
import type { LanePilotDatabase } from "../storage";
import { storeMemoryRecords } from "@lane-pilot/memory-core";
import { closeOwnerItem, closeOwnerItemsByPrefix, postOwnerItem } from "../owner-waiting";
import { answerPhaseWord, askPhaseWord } from "../lead";
import { critiqueProblems, roleLine } from "../design-eval";
import type { PhaseReactions } from "../phase/server";

export const DESIGN_JOURNAL = "lp.design.journal";
export const ROLE_LINES = "lp.role.lines";

/** The default bindings: the plugin's own rooms. Moved to the composition root, the phase room imports none of them. */
export function createPhaseReactions(db: LanePilotDatabase, bb: BbPluginApi): PhaseReactions {
  // The journal is a best-effort side effect: a KV failure is logged and the line is dropped,
  // never turned into a read of «empty» that the following set would write back over the history.
  const journalDrawing = async (line: DesignJournalLine): Promise<void> => {
    await bestEffort(bb.log, "design journal append", (async () => {
      const lines = ((await bb.storage.kv.get(DESIGN_JOURNAL)) as DesignJournalLine[] | undefined) ?? [];
      await bb.storage.kv.set(DESIGN_JOURNAL, [...lines, line].slice(-2000) as never);
    })(), undefined);
  };
  const noteDesignWord = async (phaseId: string, decision: "yes" | "no"): Promise<void> => {
    await bestEffort(bb.log, "design journal word", (async () => {
      const lines = ((await bb.storage.kv.get(DESIGN_JOURNAL)) as DesignJournalLine[] | undefined) ?? [];
      const last = [...lines].reverse().find((line) => line.phaseId === phaseId);
      if (!last) return;
      last.ownerWord = decision;
      if (decision === "no") last.firstPass = false;
      await bb.storage.kv.set(DESIGN_JOURNAL, lines as never);
    })(), undefined);
  };
  const addRoleLine = async (projectId: string, role: string, line: string): Promise<void> => {
    const key = `${ROLE_LINES}:${projectId}:${role}`;
    await bestEffort(bb.log, "role lines append", (async () => {
      const lines = ((await bb.storage.kv.get(key)) as string[] | undefined) ?? [];
      if (!lines.includes(line)) await bb.storage.kv.set(key, [...lines, line].slice(-30) as never);
    })(), undefined);
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
