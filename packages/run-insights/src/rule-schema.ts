import type Database from "better-sqlite3";

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

/**
 * 0.1.43 statements, appended by the host after the triage migrations: they were applied on the hub before
 * these existed, so these go last to keep every recorded index unchanged.
 */
export const ruleTrialMigrations: readonly string[] = [
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

/**
 * 0.1.97 statements, appended last by the host. Who a rule is for and whether it holds for every task: measured on
 * 75 SelfyStudio tasks (2026-10-03), rules meant for the PM went to almost every writer and a rule for every task
 * never did, because a per-task relevance question cannot see either; the rule's author states both.
 */
export const ruleAudienceMigrations: readonly string[] = [
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN audience TEXT NOT NULL DEFAULT 'writer'`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0`,
];

/** writer — the agent that edits code for one task; pm — planning, contracts, reviews, merges, deploys; both. */
/**
 * 0.1.247 (the Harness² port): a lesson names the FORM it should take. Always-on text is the expensive one (read on every
 * task); a check, a skill, a hook or a memory note costs nothing until it applies. The cue is the shape of situation the
 * lesson fires on, the confidence what the reflection gave it.
 */
export const ruleFormMigrations: readonly string[] = [
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN form TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN cue TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN confidence TEXT`,
];
export type RuleForm = "always" | "skill" | "check" | "hook" | "memory";
export const RULE_FORMS: readonly RuleForm[] = ["always", "skill", "check", "hook", "memory"];

export type RuleAudience = "writer" | "pm" | "both";
export const RULE_AUDIENCES: readonly RuleAudience[] = ["writer", "pm", "both"];

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
  audience: RuleAudience;
  form: RuleForm | null;
  cue: string | null;
  confidence: string | null;
  /** Why the rule has its form and who set it (heuristic | jev | owner | reflection): SMA block 6, rule-forms.ts. */
  formReason: string | null;
  formBy: string | null;
  /** The commit, test or lint code that now enforces the rule; its text then leaves the brief. */
  mechanizedBy: string | null;
  mechanizedAt: number | null;
  /** Given to every writer task without asking System One. */
  always: boolean;
};
