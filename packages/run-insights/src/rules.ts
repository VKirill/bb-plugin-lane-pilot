import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { LessonSource } from "./lessons";

export type RulesDatabase = Pick<Database.Database, "prepare">;

/** Appended by the host plugin to its own migration list; never renumbered. */
export const ruleMigrations: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lane_pilot_rule_proposal (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    rule TEXT NOT NULL,
    author TEXT NOT NULL CHECK(author IN ('sweep','pm','owner')),
    state TEXT NOT NULL CHECK(state IN ('proposed','accepted','rejected','revoked')),
    occurrences INTEGER NOT NULL,
    task_count INTEGER NOT NULL,
    examples_json TEXT NOT NULL,
    memory_id TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    PRIMARY KEY(project_id, id)
  ) WITHOUT ROWID`,
  // 0.1.38: proposals written by the analyzer model cite the tasks they come from.
  `CREATE TABLE lane_pilot_rule_proposal_v2 (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    rule TEXT NOT NULL,
    author TEXT NOT NULL CHECK(author IN ('sweep','pm','owner','model')),
    state TEXT NOT NULL CHECK(state IN ('proposed','accepted','rejected','revoked')),
    occurrences INTEGER NOT NULL,
    task_count INTEGER NOT NULL,
    examples_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    memory_id TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    PRIMARY KEY(project_id, id)
  ) WITHOUT ROWID`,
  `INSERT INTO lane_pilot_rule_proposal_v2
    (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at)
    SELECT id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at
    FROM lane_pilot_rule_proposal`,
  `DROP TABLE lane_pilot_rule_proposal`,
  `ALTER TABLE lane_pilot_rule_proposal_v2 RENAME TO lane_pilot_rule_proposal`,
  // 0.1.43: rules adopt themselves. A rule the system adopted is on trial until the tasks it was given to show
  // whether the mistake still recurs; owner decisions are never touched by the trial.
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN decided_by TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN trial_state TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN revision_started_at INTEGER`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN retired_reason TEXT`,
  `CREATE TABLE IF NOT EXISTS lane_pilot_rule_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_rule_event_project ON lane_pilot_rule_event(project_id, at DESC)`,
  // A rule belongs to the section where its mistakes happened (outermost first, [] = the whole project).
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN scope_json TEXT NOT NULL DEFAULT '[]'`,
];

export type RuleProposalState = "proposed" | "accepted" | "rejected" | "revoked";
export type RuleProposalAuthor = "sweep" | "pm" | "owner" | "model";

/** A failed attempt a proposal stands on. */
export type RuleEvidence = { runId: string; taskId: string; attemptId: string; reason: string };

export type RepeatedLesson = {
  signature: string;
  occurrences: number;
  taskCount: number;
  examples: string[];
  firstSeenAt: number;
  lastSeenAt: number;
};

export type RuleProposal = {
  id: string;
  projectId: string;
  signature: string;
  rule: string;
  author: RuleProposalAuthor;
  state: RuleProposalState;
  occurrences: number;
  taskCount: number;
  examples: string[];
  evidence: RuleEvidence[];
  memoryId: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  updatedAt: number;
  decidedAt: number | null;
  decidedBy: "owner" | "auto" | null;
  trialState: "trial" | "confirmed" | null;
  revision: number;
  revisionStartedAt: number | null;
  retiredReason: string | null;
  /** Section chain the rule applies to, outermost first; empty for the whole project. */
  scope: string[];
};

export function parseScope(json: string | null | undefined): string[] {
  try { const value = JSON.parse(json ?? "[]") as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}

/** A rule applies where its section chain is a prefix of the run's: its own section and everything below it. */
export function scopeApplies(ruleScope: readonly string[], runChain: readonly string[]): boolean {
  return ruleScope.length <= runChain.length && ruleScope.every((section, index) => runChain[index] === section);
}

const clip = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The part of a failure that stays the same when it repeats: paths, numbers, hashes and command lines are masked. */
export function normalizeLessonText(text: string): string {
  return text.toLowerCase()
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<s>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<h>")
    .replace(/[^\s,;:()]*[/\\][^\s,;:()]*|[^\s,;:()]+\.[a-z0-9]{1,8}\b/g, "<p>")
    .replace(/\d+/g, "<n>")
    .replace(/<p>(?:\s*,\s*<p>)+/g, "<p>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function sourceText(source: LessonSource): string {
  if (source.kind === "night_finding") return source.finding;
  return source.reason;
}

/** One failure is often recorded by several stages of the same attempt; the signature leaves the stage out so they count once. */
export function lessonSignature(source: LessonSource): string {
  if (source.kind === "night_finding") return `night-review ${source.severity}: ${normalizeLessonText(source.finding)}`;
  return normalizeLessonText(source.reason);
}

/** Failures of the run machinery or of the PM's plan; a rule for writers cannot prevent them. */
const NOT_WRITER = /^(internal_error|attempt_worktree_|attempt_workspace_|execution_packet_failed|writer_provider_unavailable|writer_live_catalog|writer_model_unavailable|emergency_fallback_failed|spawn_|reconcile_|ownership run scope invalid|code_critique_helper|structural_plan_critique|critique_changes_requested|merge_conflict)/i;

/** Files Lane Pilot's hooks and sibling agents write on their own; a rejection naming only these is not the writer's. */
const BOOKKEEPING_PATH = /^(\.agents\/|\.bb\/|\.claude\/|PROGRESS\.md$)/;

export function isWriterLesson(source: LessonSource): boolean {
  if (source.kind === "night_finding") return true;
  if (source.kind === "rejection" && source.stage === "plan-critique") return false;
  const paths = /(?:owns_paths rejected |never_touch: )(.+)$/s.exec(source.reason)?.[1]?.split(",").map((path) => path.trim()).filter(Boolean) ?? [];
  if (paths.length > 0 && paths.every((path) => BOOKKEEPING_PATH.test(path))) return false;
  return !NOT_WRITER.test(source.reason.trim());
}

/**
 * Writer failures with the same signature in at least `minOccurrences` distinct run tasks across at least
 * `minTasks` task ids. A task counts once however many stages recorded the failure.
 */
export function repeatedLessons(sources: readonly LessonSource[], options: { minOccurrences?: number; minTasks?: number } = {}): RepeatedLesson[] {
  const minOccurrences = options.minOccurrences ?? 3;
  const minTasks = options.minTasks ?? 2;
  const groups = new Map<string, { sources: LessonSource[]; runTasks: Set<string>; tasks: Set<string> }>();
  for (const source of sources) {
    if (!isWriterLesson(source)) continue;
    const signature = lessonSignature(source);
    const group = groups.get(signature) ?? { sources: [], runTasks: new Set<string>(), tasks: new Set<string>() };
    const runTask = `${source.runId}/${source.taskId}`;
    if (group.runTasks.has(runTask)) continue;
    group.runTasks.add(runTask);
    group.tasks.add(source.taskId);
    group.sources.push(source);
    groups.set(signature, group);
  }
  const result: RepeatedLesson[] = [];
  for (const [signature, group] of groups) {
    if (group.sources.length < minOccurrences || group.tasks.size < minTasks) continue;
    const examples = [...new Set(group.sources.map((source) => clip(sourceText(source), 300)))].slice(0, 3);
    const times = group.sources.map((source) => source.at);
    result.push({ signature, occurrences: group.sources.length, taskCount: group.tasks.size, examples,
      firstSeenAt: Math.min(...times), lastSeenAt: Math.max(...times) });
  }
  return result.sort((a, b) => b.occurrences - a.occurrences || b.lastSeenAt - a.lastSeenAt);
}

/** A first wording for the owner or the PM to rewrite; it names the failure, not the fix. */
export function draftRule(lesson: RepeatedLesson): string {
  return `Repeated in ${lesson.occurrences} tasks: ${lesson.examples[0] ?? lesson.signature} — before finishing a task, make sure this does not happen.`;
}

export function ruleProposalId(signature: string): string {
  return `rule_${createHash("sha256").update(signature).digest("hex").slice(0, 16)}`;
}

type Row = {
  id: string; project_id: string; signature: string; rule: string; author: RuleProposalAuthor; state: RuleProposalState;
  occurrences: number; task_count: number; examples_json: string; evidence_json: string; memory_id: string | null;
  first_seen_at: number; last_seen_at: number; updated_at: number; decided_at: number | null;
  decided_by: "owner" | "auto" | null; trial_state: "trial" | "confirmed" | null; revision: number; revision_started_at: number | null; retired_reason: string | null;
  scope_json?: string;
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
  const scope = [...(input.scope ?? [])];
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
export function acceptedRules(db: RulesDatabase, projectId: string, runChain?: readonly string[]): Array<{ id: string; rule: string; memoryId: string; scope: string[] }> {
  const rows = (db.prepare(`SELECT p.id, p.rule, p.memory_id AS memoryId, p.scope_json AS scopeJson FROM lane_pilot_rule_proposal p
    JOIN lane_pilot_memory m ON m.project_id=p.project_id AND m.id=p.memory_id
    WHERE p.project_id=? AND p.state='accepted' ORDER BY p.decided_at`).all(projectId) as Array<{ id: string; rule: string; memoryId: string; scopeJson: string }>)
    .map(({ scopeJson, ...row }) => ({ ...row, scope: parseScope(scopeJson) }));
  // Without a chain every rule of the project is listed; a run's chain keeps only the rules of its sections.
  return runChain ? rows.filter((row) => scopeApplies(row.scope, runChain)) : rows;
}

/**
 * Which accepted rules a writer should read for one task. Calibrated on 60 SelfyStudio contracts and two
 * rules (2026-10-01): with interfaces and invariants in the state and p(yes) ≥ 0.3, 2 of 59 needed rules
 * were missed and 4 of 61 unneeded ones added. A missed rule costs more than an extra one, hence the low bar.
 */
export const RULE_RELEVANCE_THRESHOLD = 0.3;

export function ruleRelevanceState(task: Record<string, unknown>): Record<string, unknown> {
  const commands = (Array.isArray(task.verification) ? task.verification as Array<{ command?: unknown }> : [])
    .map((row) => row.command).filter((command) => typeof command === "string");
  return { task: {
    title: task.title, objective: typeof task.objective === "string" ? task.objective.slice(0, 1200) : null,
    owns_paths: task.owns_paths, expected_outputs: task.expected_outputs, acceptance: task.acceptance,
    interfaces: task.interfaces, invariants: task.invariants, read_first: task.read_first, verification_commands: commands,
  } };
}

/** One yes/no question per rule, keyed `r1`…`rN` in the order of `rules`. */
export function ruleRelevanceQuestions(rules: ReadonlyArray<{ rule: string }>): Record<string, { instructions: string; criteria: Record<string, string> }> {
  return Object.fromEntries(rules.map((row, index) => [`r${index + 1}`, {
    instructions: "Should a writer working on this task be reminded of this project rule? Answer yes only when the task's own work or its verification commands touch what the rule is about.",
    criteria: { yes: `the rule applies to this task: ${row.rule}`.slice(0, 500), no: "the rule is about something this task does not do" },
  }]));
}

/** Rules whose probability of «yes» reaches the threshold; an unanswered rule is kept. */
export function pickRelevantRules<T>(rules: readonly T[], answers: Record<string, string>, confidence: Record<string, number>, threshold = RULE_RELEVANCE_THRESHOLD): T[] {
  return rules.filter((_, index) => {
    const key = `r${index + 1}`;
    const choice = answers[key];
    if (choice !== "yes" && choice !== "no") return true;
    const sure = confidence[key] ?? 1;
    return (choice === "yes" ? sure : 1 - sure) >= threshold;
  });
}


export type RuleEventAction = "adopted" | "confirmed" | "revised" | "retired" | "cap_reached" | "owner_accepted" | "owner_rejected" | "owner_revoked";
export type RuleEvent = { ruleId: string; action: RuleEventAction; detail: string | null; at: number };

export function logRuleEvent(db: RulesDatabase, projectId: string, ruleId: string, action: RuleEventAction, detail: string | null = null, now = Date.now()): void {
  db.prepare("INSERT INTO lane_pilot_rule_event(project_id,rule_id,action,detail,at) VALUES(?,?,?,?,?)").run(projectId, ruleId, action, detail, now);
}

export function listRuleEvents(db: RulesDatabase, projectId: string, limit = 50): RuleEvent[] {
  return db.prepare("SELECT rule_id AS ruleId, action, detail, at FROM lane_pilot_rule_event WHERE project_id=? ORDER BY at DESC, id DESC LIMIT ?")
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
  /** Writer attempts that were given the rule since its current wording. */
  applied: number;
  /** Of those, attempts that were accepted. */
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
  return {
    applied: applied.length,
    appliedAccepted: applied.filter((row) => row.state === "accepted").length,
    recurrences,
    lastAppliedAt: applied.length ? Math.max(...applied.map((row) => row.at)) : null,
  };
}

export const RULE_TRIAL = {
  /** Attempts given the rule without a recurrence before it is confirmed. */
  confirmAfterApplied: 5,
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
export function decideRuleTrial(rule: Pick<RuleProposal, "trialState" | "revision" | "revisionStartedAt" | "decidedAt">, stats: RuleTrialStats, now = Date.now()): RuleTrialDecision {
  if (stats.recurrences.length >= RULE_TRIAL.reviseAfterRecurrences) {
    return rule.revision >= RULE_TRIAL.maxRevisions ? { action: "retire", reason: "kept_recurring" } : { action: "revise" };
  }
  const since = stats.lastAppliedAt ?? rule.revisionStartedAt ?? rule.decidedAt ?? now;
  if (now - since >= RULE_TRIAL.unusedAfterMs) return { action: "retire", reason: "unused" };
  if (rule.trialState === "trial" && stats.applied >= RULE_TRIAL.confirmAfterApplied && stats.recurrences.length === 0) return { action: "confirm" };
  return { action: "keep" };
}
