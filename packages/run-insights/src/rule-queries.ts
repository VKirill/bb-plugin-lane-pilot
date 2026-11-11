import type { RuleProposalState, RulesDatabase } from "./rule-schema";
import type { RuleEventAction } from "./rule-trial";
import { pickedRuleRows } from "./rule-trial";

// ---- foreign-SQL reads moved home from the rooms (same SQL text, named) ----

/** Projects that hold a proposal in a state (the night scan's adopt pass). */
export function listProposalProjectIds(db: RulesDatabase, state: RuleProposalState): string[] {
  return (db.prepare("SELECT DISTINCT project_id FROM lane_pilot_rule_proposal WHERE state=?").all(state) as Array<{ project_id: string }>).map((row) => row.project_id);
}

/** A proposal's stored row, unparsed (the live exam's descriptor fields). */
export function ruleProposalRow(db: RulesDatabase, projectId: string, id: string): { rule: string; always_on: number } | undefined {
  return db.prepare("SELECT rule, always_on FROM lane_pilot_rule_proposal WHERE project_id=? AND id=?").get(projectId, id) as { rule: string; always_on: number } | undefined;
}

/** Rule events with their proposal's text, by action, since a time (the live exam's owner decisions). */
export function listRuleDecisionEvents(db: RulesDatabase, actions: readonly string[], since: number): Array<{ event_id: number; project_id: string; rule_id: string; action: string; detail: string | null; at: number; rule: string; always_on: number }> {
  return db.prepare(`SELECT e.id AS event_id, e.project_id, e.rule_id, e.action, e.detail, e.at, p.rule, p.always_on
    FROM lane_pilot_rule_event e JOIN lane_pilot_rule_proposal p ON p.project_id=e.project_id AND p.id=e.rule_id
    WHERE e.action IN (${actions.map(() => "?").join(",")}) AND e.at>? ORDER BY e.at`).all(...actions, since) as
    Array<{ event_id: number; project_id: string; rule_id: string; action: string; detail: string | null; at: number; rule: string; always_on: number }>;
}

/** Trial rules adopted by the night and left standing past their window without an owner override (the live exam's silent adoptions). */
export function listStandingRuleTrials(db: RulesDatabase, standingMs: number, since: number, now: number): Array<{ project_id: string; rule_id: string; at: number; rule: string; always_on: number }> {
  return db.prepare(`SELECT e.project_id, e.rule_id, e.at, p.rule, p.always_on FROM lane_pilot_rule_event e
    JOIN lane_pilot_rule_proposal p ON p.project_id=e.project_id AND p.id=e.rule_id
    WHERE e.action='adopted' AND p.state='accepted' AND e.at+?>? AND e.at+?<=?
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_rule_event o WHERE o.project_id=e.project_id AND o.rule_id=e.rule_id AND o.action IN ('owner_rejected','owner_revoked'))
    ORDER BY e.at`).all(standingMs, since, standingMs, now) as Array<{ project_id: string; rule_id: string; at: number; rule: string; always_on: number }>;
}

/** One more occurrence for a proposal (the owner's confirm). */
export function bumpRuleProposal(db: RulesDatabase, projectId: string, id: string, now = Date.now()): void {
  db.prepare("UPDATE lane_pilot_rule_proposal SET occurrences=occurrences+1, last_seen_at=?, updated_at=? WHERE project_id=? AND id=?").run(now, now, projectId, id);
}

/** Sweep-authored proposals still waiting (the scan's pre-triage clear). */
export function deleteSweepProposals(db: RulesDatabase, projectId: string): void {
  db.prepare("DELETE FROM lane_pilot_rule_proposal WHERE project_id=? AND author='sweep' AND state='proposed'").run(projectId);
}

/** Rules proven on trial or by the owner, with their projects (the cross-project sweep's pool). */
export function listProvenRules(db: RulesDatabase): Array<{ project_id: string; rule: string; audience: string }> {
  return db.prepare(`SELECT project_id, rule, audience FROM lane_pilot_rule_proposal
    WHERE state='accepted' AND (trial_state='confirmed' OR decided_by='owner')`).all() as Array<{ project_id: string; rule: string; audience: string }>;
}

/** Live rule texts of a project (the sweep's same-rule check). */
export function listLiveRuleTexts(db: RulesDatabase, projectId: string): string[] {
  return (db.prepare("SELECT rule FROM lane_pilot_rule_proposal WHERE project_id=? AND state IN ('proposed','accepted')").all(projectId) as Array<{ rule: string }>).map((row) => row.rule);
}

/** A cross-project candidate, once per project (the weekly sweep's insert). */
export function insertSweepProposal(db: RulesDatabase, input: {
  id: string; projectId: string; signature: string; rule: string; occurrences: number; taskCount: number;
  examplesJson: string; evidenceJson: string; audience: string; now: number;
}): number {
  return db.prepare(`INSERT INTO lane_pilot_rule_proposal
    (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,evidence_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,scope_json,audience)
    VALUES (?,?,?,?,'sweep','proposed',?,?,?, '[]', NULL,?,?,?,NULL,'[]',?)
    ON CONFLICT(project_id,id) DO NOTHING`)
    .run(input.id, input.projectId, input.signature, input.rule, input.occurrences, input.taskCount, input.examplesJson, input.now, input.now, input.now, input.audience).changes;
}

/** Proposals waiting for a decision, counted (the morning line). */
export function countProposedRules(db: RulesDatabase): number {
  return (db.prepare("SELECT count(*) AS n FROM lane_pilot_rule_proposal WHERE state='proposed'").get() as { n: number }).n;
}

/** Rule events of an action since a time, counted (the morning line). */
export function countRuleEvents(db: RulesDatabase, action: RuleEventAction, since: number): number {
  return (db.prepare("SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action=? AND at>=?").get(action, since) as { n: number }).n;
}

/** Accepted rule proposals' scope columns (the memory scope migration's plan and rebind). */
export function listAcceptedRuleRows(db: RulesDatabase): Array<{ id: string; project_id: string; audience: string; scope_json: string; rule: string }> {
  return db.prepare("SELECT id, project_id, audience, scope_json, rule FROM lane_pilot_rule_proposal WHERE state='accepted'").all() as
    Array<{ id: string; project_id: string; audience: string; scope_json: string; rule: string }>;
}

/** One accepted rule proposal's scope rewrite (the scope migration's apply/revert). */
export function updateRuleProposalScopeJson(db: RulesDatabase, scopeJson: string, projectId: string, id: string): void {
  db.prepare("UPDATE lane_pilot_rule_proposal SET scope_json=? WHERE project_id=? AND id=?").run(scopeJson, projectId, id);
}

/** Ids of a project's accepted rules whose text matches a LIKE pattern (the memory probe's cleanup). */
export function acceptedRuleIdsLike(db: RulesDatabase, projectId: string, ruleLike: string): string[] {
  return (db.prepare("SELECT id FROM lane_pilot_rule_proposal WHERE project_id=? AND state='accepted' AND rule LIKE ?").all(projectId, ruleLike) as Array<{ id: string }>).map((row) => row.id);
}

/**
 * Rule recurrences across all projects (SMA k_lib_curriculum): triage rows matched to a rule the attempt was given,
 * grouped by project and rule — the curriculum's "ignored rule firings" source without a rules list.
 */
export function ruleRecurrences(db: RulesDatabase, since: number, limit = 5000): Array<{ projectId: string; ruleId: string; count: number; sampleTaskId: string }> {
  // At most `limit` newest triage rows of the window; the picked rules are read for those attempts only (by the attempt id), never as a scan of every trace.
  const triaged = db.prepare(`SELECT attempt_id AS attemptId, task_id AS taskId, same_rule_id AS ruleId, project_id AS projectId, failed_at AS failedAt
    FROM lane_pilot_failure_triage WHERE same_rule_id IS NOT NULL AND status='ok' AND failed_at>=? ORDER BY failed_at DESC LIMIT ?`).all(since, limit) as Array<{ attemptId: string; taskId: string; ruleId: string; projectId: string; failedAt: number }>;
  const attemptIds = [...new Set(triaged.map((row) => row.attemptId))];
  const picked = new Set<string>();
  for (let from = 0; from < attemptIds.length; from += 400) {
    const chunk = attemptIds.slice(from, from + 400);
    for (const row of pickedRuleRows(db, null, chunk)) picked.add(`${row.id} ${row.ruleId}`);
  }
  const by = new Map<string, { projectId: string; ruleId: string; count: number; sampleTaskId: string }>();
  for (const row of triaged) {
    if (!picked.has(`${row.attemptId} ${row.ruleId}`)) continue;
    const key = `${row.projectId} ${row.ruleId}`;
    const hit = by.get(key) ?? { projectId: row.projectId, ruleId: row.ruleId, count: 0, sampleTaskId: row.taskId };
    hit.count += 1;
    by.set(key, hit);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}
