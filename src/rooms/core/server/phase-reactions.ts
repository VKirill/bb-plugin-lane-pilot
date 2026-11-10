import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import { bestEffort } from "@lane-pilot/kit";
import type { DesignJournalLine } from "@lane-pilot/contracts";
import type { LanePilotDatabase } from "../../storage";
import { storeMemoryRecords } from "@lane-pilot/memory-core";
import { closeOwnerItem, closeOwnerItemsByPrefix, postOwnerItem } from "../../owner-waiting";
import { answerPhaseWord, askPhaseWord } from "../../lead";
import { appendDesignJournalLine, critiqueProblems, noteDesignJournalWord, roleLine } from "../../design-eval";
import { roleLinesKey } from "../../contracts/server";
import type { PhaseReactions } from "../../phase/server";

/** The default bindings: the plugin's own rooms. Moved to the composition root, the phase room imports none of them. */
export function createPhaseReactions(db: LanePilotDatabase, bb: BbPluginApi): PhaseReactions {
  // The journal is a best-effort side effect: a KV failure is logged and the line is dropped,
  // never turned into a read of «empty» that the following set would write back over the history.
  const journalDrawing = async (line: DesignJournalLine): Promise<void> => {
    // Which training state the drawing was made under: the designer's role lines at write time («base» before any).
    if (!line.series) {
      const roles = ((await bb.storage.kv.get(roleLinesKey(line.projectId, line.designer)).catch(() => null)) as string[] | null) ?? [];
      line.series = roles.length ? createHash("sha256").update(roles.join("\n")).digest("hex").slice(0, 8) : "base";
    }
    await bestEffort(bb.log, "design journal append", appendDesignJournalLine(bb.storage.kv, line), undefined);
  };
  const noteDesignWord = async (phaseId: string, decision: "yes" | "no"): Promise<void> => {
    await bestEffort(bb.log, "design journal word", noteDesignJournalWord(bb.storage.kv, phaseId, decision), undefined);
  };
  const addRoleLine = async (projectId: string, role: string, line: string): Promise<void> => {
    const key = roleLinesKey(projectId, role);
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
