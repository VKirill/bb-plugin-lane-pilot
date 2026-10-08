import { memoryRecordId, storeMemoryRecords } from "@lane-pilot/memory-core";
import { listRuleProposals, upsertLessonProposal } from "@lane-pilot/run-insights";
import type { LanePilotDatabase } from "../storage/database";
import { adoptRuleProposal, deleteMemoryRecord, memorySettingsFor, rejectRuleProposal, retireAdoptedRule } from "../self-repair/server/insights";
import type { NotesPort, RulesPort } from "./extract";
import { sha256Hex } from "@lane-pilot/kit";

/** The extractor's view of Lane Pilot's rules (server/insights.ts): the same proposal, trial and retirement a PM's `lane_pilot_lesson` uses. */
export function lpRulesPort(db: LanePilotDatabase): RulesPort {
  return {
    list: (projectId) => [
      ...listRuleProposals(db, projectId, { state: "accepted", limit: 200 }),
      ...listRuleProposals(db, projectId, { state: "proposed", limit: 100 }),
    ].map((row) => ({ id: row.id, rule: row.rule, state: row.state as "proposed" | "accepted", audience: row.audience })),
    propose: (projectId, input) => upsertLessonProposal(db, projectId, { rule: input.rule, evidence: input.evidence, audience: input.audience }),
    adopt: (projectId, id) => adoptRuleProposal(db, projectId, id) !== null,
    confirm: (projectId, id) => { db.prepare("UPDATE lane_pilot_rule_proposal SET occurrences=occurrences+1, last_seen_at=?, updated_at=? WHERE project_id=? AND id=?").run(Date.now(), Date.now(), projectId, id); },
    retire: (projectId, id, reason) => retireAdoptedRule(db, projectId, id, reason),
    reject: (projectId, id) => { rejectRuleProposal(db, projectId, id); },
  };
}

/** Decisions of the owner go to the project's memory as notes, where writers and the PM find them with the memory search. */
export function lpNotesPort(db: LanePilotDatabase): NotesPort {
  return {
    remember(projectId, text, evidence, at) {
      const settings = memorySettingsFor(db, projectId);
      const content = `Decision of the owner, ${new Date(at).toISOString().slice(0, 10)}: ${text} (${evidence})`.slice(0, 900);
      const result = storeMemoryRecords(db, {
        projectId, personalBot: settings.personalBot, audience: "subagent",
        sourceSha256: sha256Hex(`learning:${content}`),
        entries: [{ kind: "note", content, concepts: ["decision", "owner-message"] }],
        coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget, origin: "learning", now: at,
      });
      return result.insertedIds[0] ?? memoryRecordId(projectId, "note", content, settings.personalBot);
    },
    forget: (projectId, memoryId) => deleteMemoryRecord(db, projectId, memoryId),
  };
}
