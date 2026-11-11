import type { RuleProposal, RulesDatabase } from "./rule-schema";

export type RuleEventAction = "adopted" | "confirmed" | "revised" | "retired" | "cap_reached" | "made_room" | "needs_second_evidence" | "owner_accepted" | "owner_rejected" | "owner_revoked" | "shown" | "tier";
export type RuleEvent = { ruleId: string; action: RuleEventAction; detail: string | null; at: number };

export function logRuleEvent(db: RulesDatabase, projectId: string, ruleId: string, action: RuleEventAction, detail: string | null = null, now = Date.now()): void {
  db.prepare("INSERT INTO lane_pilot_rule_event(project_id,rule_id,action,detail,at) VALUES(?,?,?,?,?)").run(projectId, ruleId, action, detail, now);
}

/**
 * A rule entered a PM's prompt (`detail` = `pm:<runId>` for a session's start or resume, `task:<taskId>` for a dispatch): one event per rule and
 * detail, so a session resumed ten times counts once. The trial reads these as the PM rule's uses (harness batch 2026-11-02; before it a PM
 * rule had no recorded use, so it could neither be confirmed nor retired).
 */
export function logRulesShown(db: RulesDatabase, projectId: string, ruleIds: readonly string[], detail: string, now = Date.now()): number {
  let added = 0;
  for (const ruleId of ruleIds) {
    added += db.prepare(`INSERT INTO lane_pilot_rule_event(project_id,rule_id,action,detail,at) SELECT ?,?,'shown',?,?
      WHERE NOT EXISTS (SELECT 1 FROM lane_pilot_rule_event WHERE project_id=? AND rule_id=? AND action='shown' AND detail=?)`).run(projectId, ruleId, detail, now, projectId, ruleId, detail).changes;
  }
  return added;
}

/** The last 30/50 rows are the rule history readers show; the ladder's `tier` rows are bookkeeping and never take a slot in it. */
export function listRuleEvents(db: RulesDatabase, projectId: string, limit = 50): RuleEvent[] {
  return db.prepare("SELECT rule_id AS ruleId, action, detail, at FROM lane_pilot_rule_event WHERE project_id=? AND action<>'tier' ORDER BY at DESC, id DESC LIMIT ?")
    .all(projectId, Math.min(Math.max(limit, 1), 500)) as RuleEvent[];
}

/** Marks who decided a rule and, for the system's own decisions, where its trial stands. */
export function setRuleTrial(db: RulesDatabase, projectId: string, id: string, fields: {
  decidedBy?: "owner" | "auto"; trialState?: "trial" | "confirmed" | null; revisionStartedAt?: number; retiredReason?: string | null;
}): void {
  db.prepare(`UPDATE lane_pilot_rule_proposal SET decided_by=COALESCE(?,decided_by),
      trial_state=CASE WHEN ? THEN ? ELSE trial_state END, revision_started_at=COALESCE(?,revision_started_at),
      retired_reason=CASE WHEN ? THEN ? ELSE retired_reason END WHERE project_id=? AND id=?`)
    .run(fields.decidedBy ?? null, fields.trialState !== undefined ? 1 : 0, fields.trialState ?? null, fields.revisionStartedAt ?? null,
      fields.retiredReason !== undefined ? 1 : 0, fields.retiredReason ?? null, projectId, id);
}

/** A trial rule gets a new wording: the counters start again from now. */
export function reviseAdoptedRule(db: RulesDatabase, projectId: string, id: string, rule: string, memoryId: string, now = Date.now()): boolean {
  return db.prepare(`UPDATE lane_pilot_rule_proposal SET rule=?, memory_id=?, revision=revision+1, revision_started_at=?, updated_at=?
    WHERE project_id=? AND id=? AND state='accepted'`).run(rule, memoryId, now, now, projectId, id).changes === 1;
}

export type RuleTrialStats = {
  /** Writer attempts that were given the rule, plus PM prompts it entered (`shown` events), since its current wording. */
  applied: number;
  /** Of those, attempts that were accepted; a PM prompt counts as accepted (nothing measures it). */
  appliedAccepted: number;
  /** Failures System One matched to the rule among the attempts that were given it: the rule did not prevent them. */
  recurrences: Array<{ attemptId: string; taskId: string; reason: string }>;
  lastAppliedAt: number | null;
};

/**
 * Derived from what is already recorded (the attempt trace's picked rules and the triage's rule match), so a
 * re-triage or a reload never counts twice.
 */
export function ruleTrialStats(db: RulesDatabase, projectId: string, ruleId: string, since: number): RuleTrialStats {
  const applied = db.prepare(`SELECT a.id, a.state, a.created_at AS at FROM lane_pilot_attempt_reasoning r
      JOIN lane_pilot_attempt a ON a.id=r.attempt_id JOIN lane_pilot_run run ON run.id=a.run_id,
      json_each(COALESCE(json_extract(r.trace_json,'$.dispatchContext.rulesPicked.picked'),'[]')) p
    WHERE run.project_id=? AND p.value=? AND a.created_at>=?`).all(projectId, ruleId, since) as Array<{ id: string; state: string; at: number }>;
  const ids = new Set(applied.map((row) => row.id));
  const recurrences = (db.prepare(`SELECT attempt_id AS attemptId, task_id AS taskId, reason FROM lane_pilot_failure_triage
    WHERE project_id=? AND same_rule_id=? AND status='ok' AND failed_at>=?`).all(projectId, ruleId, since) as Array<{ attemptId: string; taskId: string; reason: string }>)
    .filter((row) => ids.has(row.attemptId));
  const shown = shownStats(db, projectId).get(ruleId);
  return withShown({
    applied: applied.length,
    appliedAccepted: applied.filter((row) => row.state === "accepted").length,
    recurrences,
    lastAppliedAt: applied.length ? Math.max(...applied.map((row) => row.at)) : null,
  }, shown, since);
}

/** PM uses per rule: the `shown` events, as (count since, last at). */
function shownStats(db: RulesDatabase, projectId: string): Map<string, Array<{ at: number }>> {
  const out = new Map<string, Array<{ at: number }>>();
  for (const row of db.prepare("SELECT rule_id AS ruleId, at FROM lane_pilot_rule_event WHERE project_id=? AND action='shown'").all(projectId) as Array<{ ruleId: string; at: number }>) out.set(row.ruleId, [...(out.get(row.ruleId) ?? []), { at: row.at }]);
  return out;
}
function withShown(stats: RuleTrialStats, shown: Array<{ at: number }> | undefined, since: number): RuleTrialStats {
  const uses = (shown ?? []).filter((row) => row.at >= since);
  if (!uses.length) return stats;
  const last = Math.max(...uses.map((row) => row.at));
  return { ...stats, applied: stats.applied + uses.length, appliedAccepted: stats.appliedAccepted + uses.length, lastAppliedAt: Math.max(stats.lastAppliedAt ?? 0, last) };
}

/**
 * `ruleTrialStats` for many rules in two queries instead of two per rule: the rules list of a project with two dozen
 * rules re-read the attempts' reasoning traces once per rule. Same numbers, same derivation.
 */
/** Attempts a rule was given to, with which rule: the one query `ruleTrialStatsMany` and `ruleRecurrences` share. */
export function pickedRuleRows(db: RulesDatabase, projectId: string | null, attemptIds?: readonly string[]): Array<{ id: string; state: string; at: number; ruleId: string }> {
  // With `attemptIds` the rows are those attempts' only (read by the attempt id, never a scan of every trace).
  const byAttempt = attemptIds ? `a.id IN (${attemptIds.map(() => "?").join(",")})` : "run.project_id=?";
  return db.prepare(`SELECT a.id, a.state, a.created_at AS at, p.value AS ruleId FROM lane_pilot_attempt_reasoning r
      JOIN lane_pilot_attempt a ON a.id=r.attempt_id JOIN lane_pilot_run run ON run.id=a.run_id,
      json_each(COALESCE(json_extract(r.trace_json,'$.dispatchContext.rulesPicked.picked'),'[]')) p
    WHERE ${byAttempt}`).all(...(attemptIds ?? [projectId])) as Array<{ id: string; state: string; at: number; ruleId: string }>;
}

export function ruleTrialStatsMany(db: RulesDatabase, projectId: string, rules: ReadonlyArray<{ id: string; since: number }>): Map<string, RuleTrialStats> {
  const out = new Map<string, RuleTrialStats>();
  if (!rules.length) return out;
  const picked = pickedRuleRows(db, projectId);
  const triaged = db.prepare(`SELECT attempt_id AS attemptId, task_id AS taskId, reason, same_rule_id AS ruleId, failed_at AS failedAt FROM lane_pilot_failure_triage
    WHERE project_id=? AND same_rule_id IS NOT NULL AND status='ok'`).all(projectId) as Array<{ attemptId: string; taskId: string; reason: string; ruleId: string; failedAt: number }>;
  const shown = shownStats(db, projectId);
  for (const { id, since } of rules) {
    const applied = picked.filter((row) => row.ruleId === id && row.at >= since);
    const ids = new Set(applied.map((row) => row.id));
    const recurrences = triaged.filter((row) => row.ruleId === id && row.failedAt >= since && ids.has(row.attemptId))
      .map(({ attemptId, taskId, reason }) => ({ attemptId, taskId, reason }));
    out.set(id, withShown({
      applied: applied.length,
      appliedAccepted: applied.filter((row) => row.state === "accepted").length,
      recurrences,
      lastAppliedAt: applied.length ? Math.max(...applied.map((row) => row.at)) : null,
    }, shown.get(id), since));
  }
  return out;
}

export const RULE_TRIAL = {
  /** Attempts given the rule without a recurrence before it is confirmed. */
  confirmAfterApplied: 5,
  /** Least share of accepted attempts among the ones the rule was given to before it is confirmed (rank 13). */
  confirmMinAcceptedRate: 0.8,
  /** Recurrences among attempts given the rule before it is rewritten or retired. */
  reviseAfterRecurrences: 2,
  /** Wordings a rule may have before a further recurrence retires it. */
  maxRevisions: 2,
  /** Rules in force per project the system may adopt up to; the owner's are counted too. */
  maxActive: 12,
  /** A rule nobody needed for this long leaves. */
  unusedAfterMs: 60 * 24 * 3_600_000,
} as const;

export type RuleTrialDecision = { action: "keep" } | { action: "confirm" } | { action: "revise" } | { action: "retire"; reason: "kept_recurring" | "unused" };

/** What the system does with one rule it adopted; owner decisions never reach this. */
export function decideRuleTrial(rule: Pick<RuleProposal, "trialState" | "revision" | "revisionStartedAt" | "decidedAt"> & Partial<Pick<RuleProposal, "audience">>, stats: RuleTrialStats, now = Date.now()): RuleTrialDecision {
  if (stats.recurrences.length >= RULE_TRIAL.reviseAfterRecurrences) {
    return rule.revision >= RULE_TRIAL.maxRevisions ? { action: "retire", reason: "kept_recurring" } : { action: "revise" };
  }
  const since = stats.lastAppliedAt ?? rule.revisionStartedAt ?? rule.decidedAt ?? now;
  // A PM rule's uses are its `shown` events (logRulesShown, since the harness batch of 2026-11-02); before that it had none, and «unused»
  // would have retired every PM rule at 60 days whatever the PM read (Gemini F-010).
  if (now - since >= RULE_TRIAL.unusedAfterMs) return { action: "retire", reason: "unused" };
  if (rule.trialState === "trial" && stats.applied >= RULE_TRIAL.confirmAfterApplied && stats.recurrences.length === 0 && stats.appliedAccepted / stats.applied >= RULE_TRIAL.confirmMinAcceptedRate) return { action: "confirm" };
  return { action: "keep" };
}
