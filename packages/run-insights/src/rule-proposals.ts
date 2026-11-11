import { createHash } from "node:crypto";
import { RULE_FORMS } from "./rule-schema";
import type { RepeatedLesson, RuleAudience, RuleEvidence, RuleForm, RuleProposal, RuleProposalAuthor, RuleProposalState, RulesDatabase } from "./rule-schema";
import { clip, draftRule } from "./lesson-signatures";
import { assertRuleScope, parseScope, scopeApplies } from "./rule-scope";

export function ruleProposalId(signature: string): string {
  return `rule_${createHash("sha256").update(signature).digest("hex").slice(0, 16)}`;
}

type Row = {
  id: string; project_id: string; signature: string; rule: string; author: RuleProposalAuthor; state: RuleProposalState;
  occurrences: number; task_count: number; examples_json: string; evidence_json: string; memory_id: string | null;
  first_seen_at: number; last_seen_at: number; updated_at: number; decided_at: number | null;
  decided_by: "owner" | "auto" | null; trial_state: "trial" | "confirmed" | null; revision: number; revision_started_at: number | null; retired_reason: string | null;
  scope_json?: string;
  audience?: RuleAudience; always_on?: number; form?: RuleForm | null; cue?: string | null; confidence?: string | null;
  form_reason?: string | null; form_by?: string | null; mechanized_by?: string | null; mechanized_at?: number | null;
};

function fromRow(row: Row): RuleProposal {
  return {
    id: row.id, projectId: row.project_id, signature: row.signature, rule: row.rule, author: row.author, state: row.state,
    occurrences: row.occurrences, taskCount: row.task_count, examples: JSON.parse(row.examples_json) as string[],
    evidence: JSON.parse(row.evidence_json) as RuleEvidence[],
    memoryId: row.memory_id, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, updatedAt: row.updated_at, decidedAt: row.decided_at,
    decidedBy: row.decided_by ?? null, trialState: row.trial_state ?? null, revision: row.revision ?? 1,
    revisionStartedAt: row.revision_started_at ?? null, retiredReason: row.retired_reason ?? null,
    scope: parseScope(row.scope_json),
    audience: row.audience ?? "writer", always: row.always_on === 1, form: row.form ?? null, cue: row.cue ?? null, confidence: row.confidence ?? null,
    formReason: row.form_reason ?? null, formBy: row.form_by ?? null, mechanizedBy: row.mechanized_by ?? null, mechanizedAt: row.mechanized_at ?? null,
  };
}

/**
 * New repeated lessons become `proposed` rules; known ones only refresh their counts and examples, so an
 * owner's decision or a PM's wording is never overwritten.
 */
export function upsertRuleProposals(db: RulesDatabase, projectId: string, lessons: readonly RepeatedLesson[], now = Date.now()): { created: number } {
  const statement = db.prepare(`INSERT INTO lane_pilot_rule_proposal
    (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at)
    VALUES (?,?,?,?,'sweep','proposed',?,?,?,NULL,?,?,?,NULL)
    ON CONFLICT(project_id,id) DO UPDATE SET occurrences=excluded.occurrences, task_count=excluded.task_count,
      examples_json=excluded.examples_json, last_seen_at=MAX(last_seen_at,excluded.last_seen_at),
      first_seen_at=MIN(first_seen_at,excluded.first_seen_at)`);
  const known = new Set((db.prepare("SELECT id FROM lane_pilot_rule_proposal WHERE project_id=?").all(projectId) as Array<{ id: string }>).map((row) => row.id));
  let created = 0;
  for (const lesson of lessons) {
    const id = ruleProposalId(lesson.signature);
    if (!known.has(id)) created++;
    statement.run(id, projectId, lesson.signature, draftRule(lesson), lesson.occurrences, lesson.taskCount,
      JSON.stringify(lesson.examples), lesson.firstSeenAt, lesson.lastSeenAt, now);
  }
  return { created };
}

/**
 * A rule the analyzer model wrote for one group of writer failures. Its id comes from the rule text, so a
 * second scan that writes the same rule refreshes it instead of adding a copy.
 */
export function upsertModelProposal(db: RulesDatabase, projectId: string, input: {
  category: string; rule: string; evidence: RuleEvidence[]; firstSeenAt: number; lastSeenAt: number; scope?: readonly string[];
}, now = Date.now()): { id: string; created: boolean } {
  const rule = input.rule.replace(/\s+/g, " ").trim().slice(0, 600);
  const scope = assertRuleScope(input.scope ?? []);
  const signature = `model:${scope.join("/")}:${input.category}:${createHash("sha256").update(rule.toLowerCase()).digest("hex").slice(0, 12)}`;
  const id = ruleProposalId(signature);
  const created = !getRuleProposal(db, projectId, id);
  const tasks = new Set(input.evidence.map((row) => `${row.runId}/${row.taskId}`));
  const examples = [...new Set(input.evidence.map((row) => clip(row.reason, 300)))].slice(0, 3);
  db.prepare(`INSERT INTO lane_pilot_rule_proposal
    (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,evidence_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,scope_json)
    VALUES (?,?,?,?,'model','proposed',?,?,?,?,NULL,?,?,?,NULL,?)
    ON CONFLICT(project_id,id) DO UPDATE SET occurrences=excluded.occurrences, task_count=excluded.task_count,
      examples_json=excluded.examples_json, evidence_json=excluded.evidence_json, last_seen_at=MAX(last_seen_at,excluded.last_seen_at)`)
    .run(id, projectId, signature, rule, input.evidence.length, tasks.size, JSON.stringify(examples), JSON.stringify(input.evidence.slice(0, 50)),
      input.firstSeenAt, input.lastSeenAt, now, JSON.stringify(scope));
  return { id, created };
}

/** Words that carry a rule's meaning; two rules about the same thing share most of them. */
function ruleWords(rule: string): Set<string> {
  return new Set((rule.toLowerCase().match(/[\p{L}\p{N}_./-]{4,}/gu) ?? []));
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** A rule the same as a live one is a repeat of it, not a new proposal. */
export const LESSON_SAME_RULE = 0.6;
/** Lessons waiting beyond this count expire, oldest first; they never pile up. */
export const LESSON_PROPOSALS_MAX = 30;

/**
 * A lesson from a session — the owner corrected the agent, or it got burned — becomes a rule proposal on the hub
 * instead of a line in .agents/LESSONS.md, which grew without bound (≈150 entries in SelfyStudio, 2026-10-03).
 * A lesson close to a proposed or accepted rule counts as a repeat of it.
 */
export function upsertLessonProposal(db: RulesDatabase, projectId: string, input: { rule: string; evidence?: string; scope?: readonly string[]; audience?: RuleAudience; always?: boolean; form?: RuleForm | null; cue?: string | null; confidence?: string | null }, now = Date.now()):
  { id: string; created: boolean; repeatOf: string | null } {
  const rule = clip(input.rule, 600);
  const words = ruleWords(rule);
  // A rule a mechanism now enforces (mechanized_by) left the brief on purpose: its lesson coming back counts as a repeat of it, not as a new proposal.
  const live = db.prepare("SELECT id, rule FROM lane_pilot_rule_proposal WHERE project_id=? AND (state IN ('proposed','accepted') OR mechanized_by IS NOT NULL)").all(projectId) as Array<{ id: string; rule: string }>;
  const twin = live.map((row) => ({ row, score: similarity(words, ruleWords(row.rule)) })).sort((a, b) => b.score - a.score)[0];
  if (twin && twin.score >= LESSON_SAME_RULE) {
    db.prepare("UPDATE lane_pilot_rule_proposal SET occurrences=occurrences+1, last_seen_at=?, updated_at=? WHERE project_id=? AND id=?").run(now, now, projectId, twin.row.id);
    return { id: twin.row.id, created: false, repeatOf: twin.row.id };
  }
  const scope = assertRuleScope(input.scope ?? []);
  const signature = `lesson:${scope.join("/")}:${createHash("sha256").update(rule.toLowerCase()).digest("hex").slice(0, 12)}`;
  const id = ruleProposalId(signature);
  const examples = input.evidence ? [clip(input.evidence, 300)] : [];
  db.prepare(`INSERT INTO lane_pilot_rule_proposal
    (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,evidence_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,scope_json,audience,always_on,form,cue,confidence)
    VALUES (?,?,?,?,'pm','proposed',1,0,?,'[]',NULL,?,?,?,NULL,?,?,?,?,?,?)
    ON CONFLICT(project_id,id) DO UPDATE SET occurrences=occurrences+1, last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at`)
    .run(id, projectId, signature, rule, JSON.stringify(examples), now, now, now, JSON.stringify(scope), input.audience ?? "both", input.always ? 1 : 0,
      input.form && RULE_FORMS.includes(input.form) ? input.form : null, input.cue ? clip(input.cue, 300) : null, input.confidence ? clip(input.confidence, 40) : null);
  const waiting = db.prepare("SELECT id FROM lane_pilot_rule_proposal WHERE project_id=? AND state='proposed' AND signature LIKE 'lesson:%' ORDER BY last_seen_at DESC").all(projectId) as Array<{ id: string }>;
  for (const old of waiting.slice(LESSON_PROPOSALS_MAX)) {
    db.prepare("UPDATE lane_pilot_rule_proposal SET state='rejected', updated_at=?, decided_at=? WHERE project_id=? AND id=? AND state='proposed'").run(now, now, projectId, old.id);
  }
  return { id, created: true, repeatOf: null };
}

const STATE_ORDER = "CASE state WHEN 'proposed' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END";

export function listRuleProposals(db: RulesDatabase, projectId: string, filter: { state?: RuleProposalState; limit?: number } = {}): RuleProposal[] {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const rows = filter.state
    ? db.prepare(`SELECT * FROM lane_pilot_rule_proposal WHERE project_id=? AND state=? ORDER BY occurrences DESC, last_seen_at DESC LIMIT ?`).all(projectId, filter.state, limit)
    : db.prepare(`SELECT * FROM lane_pilot_rule_proposal WHERE project_id=? ORDER BY ${STATE_ORDER}, occurrences DESC, last_seen_at DESC LIMIT ?`).all(projectId, limit);
  return (rows as Row[]).map(fromRow);
}

export function getRuleProposal(db: RulesDatabase, projectId: string, id: string): RuleProposal | null {
  const row = db.prepare("SELECT * FROM lane_pilot_rule_proposal WHERE project_id=? AND id=?").get(projectId, id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Who a rule is for and whether every writer task gets it; any state, so the owner can correct a live rule. */
export function setRuleAudience(db: RulesDatabase, projectId: string, id: string, audience: RuleAudience, always: boolean, now = Date.now()): boolean {
  return db.prepare("UPDATE lane_pilot_rule_proposal SET audience=?, always_on=?, updated_at=? WHERE project_id=? AND id=?")
    .run(audience, always ? 1 : 0, now, projectId, id).changes === 1;
}

/** Rewords a rule that is still waiting for the owner. */
export function reviseRuleProposal(db: RulesDatabase, projectId: string, id: string, rule: string, author: RuleProposalAuthor, now = Date.now()): boolean {
  return db.prepare("UPDATE lane_pilot_rule_proposal SET rule=?, author=?, updated_at=? WHERE project_id=? AND id=? AND state='proposed'")
    .run(rule, author, now, projectId, id).changes === 1;
}

/** Compare-and-swap on the state, so two screens cannot decide the same proposal twice. */
export function decideRuleProposal(db: RulesDatabase, projectId: string, id: string, input: {
  from: RuleProposalState; to: RuleProposalState; rule?: string; author?: RuleProposalAuthor; memoryId?: string | null;
}, now = Date.now()): boolean {
  return db.prepare(`UPDATE lane_pilot_rule_proposal SET state=?, rule=COALESCE(?,rule), author=COALESCE(?,author), memory_id=?, updated_at=?, decided_at=?
    WHERE project_id=? AND id=? AND state=?`)
    .run(input.to, input.rule ?? null, input.author ?? null, input.memoryId ?? null, now, now, projectId, id, input.from).changes === 1;
}

/** Accepted rules whose memory record still exists: what every writer of the project must read. */
export function acceptedRules(db: RulesDatabase, projectId: string, runChain?: readonly string[], paths?: readonly string[]): Array<{ id: string; rule: string; memoryId: string; scope: string[]; audience: RuleAudience; always: boolean }> {
  const rows = (db.prepare(`SELECT p.id, p.rule, p.memory_id AS memoryId, p.scope_json AS scopeJson, p.audience, p.always_on AS alwaysOn FROM lane_pilot_rule_proposal p
    JOIN lane_pilot_memory m ON m.project_id=p.project_id AND m.id=p.memory_id
    WHERE p.project_id=? AND p.state='accepted' ORDER BY p.decided_at`).all(projectId) as Array<{ id: string; rule: string; memoryId: string; scopeJson: string; audience: RuleAudience; alwaysOn: number }>)
    .map(({ scopeJson, alwaysOn, ...row }) => ({ ...row, scope: parseScope(scopeJson), always: alwaysOn === 1 }));
  // Without a chain every rule of the project is listed; a run's chain keeps only the rules of its sections.
  return runChain ? rows.filter((row) => scopeApplies(row.scope, runChain, paths)) : rows;
}
