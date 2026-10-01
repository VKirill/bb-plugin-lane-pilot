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
};

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
};

function fromRow(row: Row): RuleProposal {
  return {
    id: row.id, projectId: row.project_id, signature: row.signature, rule: row.rule, author: row.author, state: row.state,
    occurrences: row.occurrences, taskCount: row.task_count, examples: JSON.parse(row.examples_json) as string[],
    evidence: JSON.parse(row.evidence_json) as RuleEvidence[],
    memoryId: row.memory_id, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, updatedAt: row.updated_at, decidedAt: row.decided_at,
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
  category: string; rule: string; evidence: RuleEvidence[]; firstSeenAt: number; lastSeenAt: number;
}, now = Date.now()): { id: string; created: boolean } {
  const rule = input.rule.replace(/\s+/g, " ").trim().slice(0, 600);
  const signature = `model:${input.category}:${createHash("sha256").update(rule.toLowerCase()).digest("hex").slice(0, 12)}`;
  const id = ruleProposalId(signature);
  const created = !getRuleProposal(db, projectId, id);
  const tasks = new Set(input.evidence.map((row) => `${row.runId}/${row.taskId}`));
  const examples = [...new Set(input.evidence.map((row) => clip(row.reason, 300)))].slice(0, 3);
  db.prepare(`INSERT INTO lane_pilot_rule_proposal
    (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,evidence_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at)
    VALUES (?,?,?,?,'model','proposed',?,?,?,?,NULL,?,?,?,NULL)
    ON CONFLICT(project_id,id) DO UPDATE SET occurrences=excluded.occurrences, task_count=excluded.task_count,
      examples_json=excluded.examples_json, evidence_json=excluded.evidence_json, last_seen_at=MAX(last_seen_at,excluded.last_seen_at)`)
    .run(id, projectId, signature, rule, input.evidence.length, tasks.size, JSON.stringify(examples), JSON.stringify(input.evidence.slice(0, 50)),
      input.firstSeenAt, input.lastSeenAt, now);
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
export function acceptedRules(db: RulesDatabase, projectId: string): Array<{ id: string; rule: string; memoryId: string }> {
  return db.prepare(`SELECT p.id, p.rule, p.memory_id AS memoryId FROM lane_pilot_rule_proposal p
    JOIN lane_pilot_memory m ON m.project_id=p.project_id AND m.id=p.memory_id
    WHERE p.project_id=? AND p.state='accepted' ORDER BY p.decided_at`).all(projectId) as Array<{ id: string; rule: string; memoryId: string }>;
}
