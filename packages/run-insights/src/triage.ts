import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type TriageDatabase = Pick<Database.Database, "prepare">;

/** Appended by the host plugin to its own migration list; never renumbered. */
export const triageMigrations: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lane_pilot_failure_triage (
    project_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    reason_sha256 TEXT NOT NULL,
    reason TEXT NOT NULL,
    origin TEXT,
    origin_confidence REAL,
    category TEXT,
    category_confidence REAL,
    same_rule_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('ok','error')),
    detail TEXT,
    failed_at INTEGER NOT NULL,
    triaged_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, attempt_id)
  ) WITHOUT ROWID`,
];

export const TRIAGE_ORIGINS = ["writer", "orchestrator", "environment", "task", "unclear"] as const;
export const TRIAGE_CATEGORIES = ["missing_output", "broke_checks", "outside_scope", "skipped_checks", "acceptance_unmet", "other"] as const;
export type TriageOrigin = (typeof TRIAGE_ORIGINS)[number];

/** A typed question in the shape the host's System One call takes. */
export type JudgeQuestion = { instructions: string; criteria: Record<string, string> };

/**
 * Wording calibrated on 35 labelled hub failures (2026-10-01): writer-or-not 35/35 in two runs,
 * category 7/7 on the writer ones. Change it only together with a new calibration run.
 */
const ORIGIN_QUESTION: JudgeQuestion = {
  instructions: "Who caused this failed writer attempt? Decide from the failure reason and the facts computed by code.",
  criteria: {
    writer: "the writer agent's own work was wrong or incomplete: it did not create an expected file, its code failed the project's tests or build, it edited files it should not",
    orchestrator: "Lane Pilot's own machinery failed: bookkeeping files counted against the writer, internal error codes, worktree or reconcile or merge problems, gate bugs",
    environment: "the machine or provider: sandbox restrictions, no network, missing binaries, not a git repository, provider or thread crashed",
    task: "the PM's task contract was wrong: nonexistent or invalid read_first paths, expected outputs written as prose sentences (see expected_outputs_written_as_prose_not_paths) so no file can match them, verification commands that cannot pass as written",
    unclear: "the evidence is not enough to tell",
  },
};

const CATEGORY_QUESTION: JudgeQuestion = {
  instructions: "If the writer is at fault, what kind of mistake is this?",
  criteria: {
    missing_output: "the writer did not create or update a file the task expected",
    broke_checks: "the project's tests, typecheck or build failed after the writer's change",
    outside_scope: "the writer edited files outside the paths it owns or inside never_touch",
    skipped_checks: "the writer did not run the verification commands or claimed success without evidence",
    acceptance_unmet: "the change exists but does not meet an acceptance criterion or a reviewer finding",
    other: "none of the above",
  },
};

/** Option keys are `r1`…`rN` in the order of `rules`; `none` when no rule covers the failure. */
export function triageQuestions(rules: ReadonlyArray<{ rule: string }>): Record<string, JudgeQuestion> {
  const questions: Record<string, JudgeQuestion> = { origin: ORIGIN_QUESTION, category: CATEGORY_QUESTION };
  if (rules.length > 0) {
    questions.same_rule = {
      instructions: "Is this failure the same mistake that one of these project rules is about?",
      criteria: {
        ...Object.fromEntries(rules.map((row, index) => [`r${index + 1}`, row.rule.slice(0, 480)])),
        none: "no rule above is about this mistake",
      },
    };
  }
  return questions;
}

/** Files Lane Pilot, its hooks and sibling agents write on their own; a writer never owns them. */
const BOOKKEEPING = /^(\.agents\/|\.bb\/|\.claude\/|PROGRESS\.md$)/;

/** Bump when the facts, the questions or the code verdicts change: every stored answer is asked again. */
export const TRIAGE_VERSION = "2";

/** Paths an ownership rejection names. */
export function rejectedPaths(reason: string): string[] {
  return /(?:owns_paths rejected |never_touch: )(.+)$/s.exec(reason)?.[1]?.split(",").map((path) => path.trim()).filter(Boolean) ?? [];
}

/** Rejected paths split by who they belong to; `owned` uses the host plugin's own glob rules. */
export type RejectedPathSplit = { owned: string[]; bookkeeping: string[]; outside: string[] };

export function splitRejectedPaths(reason: string, owns: (path: string) => boolean): RejectedPathSplit {
  const split: RejectedPathSplit = { owned: [], bookkeeping: [], outside: [] };
  for (const path of rejectedPaths(reason)) {
    if (BOOKKEEPING.test(path)) split.bookkeeping.push(path);
    else if (owns(path)) split.owned.push(path);
    else split.outside.push(path);
  }
  return split;
}

/**
 * Verdicts code can give without asking: an ownership gate that rejected the task's own files, or only
 * bookkeeping files, failed itself (the sibling never_touch union fixed in 0.1.24 did exactly this).
 */
export function codeVerdict(split: RejectedPathSplit): { origin: "orchestrator"; detail: string } | null {
  if (split.owned.length > 0) return { origin: "orchestrator", detail: "code:gate_rejected_owned_paths" };
  if (split.bookkeeping.length > 0 && split.outside.length === 0) return { origin: "orchestrator", detail: "code:bookkeeping_only" };
  return null;
}

export type FailedAttempt = {
  attemptId: string; runId: string; taskId: string; state: string; reason: string; contractJson: string; threadId: string | null; failedAt: number;
};

/** What System One reads: the failure, the task, and the facts code can settle on its own (jevals' split). */
export function triageState(attempt: FailedAttempt, split: RejectedPathSplit = { owned: [], bookkeeping: [], outside: rejectedPaths(attempt.reason) }): Record<string, unknown> {
  let contract: Record<string, unknown> = {};
  try { contract = JSON.parse(attempt.contractJson) as Record<string, unknown>; } catch { /* reason alone */ }
  const list = (key: string) => (Array.isArray(contract[key]) ? contract[key] as unknown[] : []).filter((item): item is string => typeof item === "string");
  const reason = attempt.reason;
  const rejected = rejectedPaths(reason);
  const outputs = list("expected_outputs");
  return {
    attempt_state: attempt.state,
    failure_reason: reason.slice(0, 1500),
    task: {
      title: contract.title ?? null,
      objective: typeof contract.objective === "string" ? contract.objective.slice(0, 600) : null,
      owns_paths: list("owns_paths"),
      expected_outputs: outputs,
      verification_commands: (Array.isArray(contract.verification) ? contract.verification as Array<{ command?: unknown }> : []).map((row) => row.command).filter((command) => typeof command === "string"),
    },
    facts_computed_by_code: {
      paths_rejected_by_ownership_gate: rejected.slice(0, 40),
      all_rejected_paths_are_lane_pilot_bookkeeping: rejected.length > 0 ? rejected.every((path) => BOOKKEEPING.test(path)) : null,
      rejected_paths_outside_this_task_scope: split.outside.slice(0, 40),
      reason_is_an_internal_error_code_of_the_orchestrator: /^[a-z][a-z0-9_]+(:|$)/.test(reason) && !reason.startsWith("owns_paths"),
      expected_outputs_written_as_prose_not_paths: outputs.some((output) => /\s/.test(output.trim())),
    },
    background: "Lane Pilot is the orchestrator: it spawns writer agents, runs gates (ownership, verification commands in a sandbox, expected outputs), provisions git worktrees and reconciles threads. Its hooks write .agents/** and .bb/** bookkeeping files on their own. A PM agent writes the task contract.",
  };
}

const sha = (text: string) => createHash("sha256").update(`${TRIAGE_VERSION}\n${text}`).digest("hex");

/** Failed attempts since `since` that have no triage for their current reason yet, oldest first. */
export function untriagedAttempts(db: TriageDatabase, projectId: string, since: number, limit = 200): FailedAttempt[] {
  const rows = db.prepare(`SELECT a.id AS attemptId, a.run_id AS runId, a.task_id AS taskId, a.state, a.reason, t.contract_json AS contractJson,
      a.thread_id AS threadId, a.updated_at AS failedAt, f.reason_sha256 AS known
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id JOIN lane_pilot_task t ON t.id=a.task_id
    LEFT JOIN lane_pilot_failure_triage f ON f.project_id=r.project_id AND f.attempt_id=a.id AND f.status='ok'
    WHERE r.project_id=? AND a.updated_at>=? AND a.reason IS NOT NULL
      AND a.state IN ('validation_failed','empty_output','blocked','failed','rejected')
      AND a.reason NOT LIKE 'retry limit%' AND a.reason NOT LIKE 'needs_human:%'
    ORDER BY a.updated_at`).all(projectId, since) as Array<FailedAttempt & { known: string | null }>;
  return rows.filter((row) => row.known !== sha(row.reason)).slice(0, Math.max(1, limit)).map(({ known: _known, ...row }) => row);
}

export function saveTriage(db: TriageDatabase, projectId: string, attempt: FailedAttempt, result: {
  status: "ok" | "error"; detail?: string | null;
  origin?: string | null; originConfidence?: number | null; category?: string | null; categoryConfidence?: number | null; sameRuleId?: string | null;
}, now = Date.now()): void {
  db.prepare(`INSERT INTO lane_pilot_failure_triage
    (project_id,attempt_id,run_id,task_id,reason_sha256,reason,origin,origin_confidence,category,category_confidence,same_rule_id,status,detail,failed_at,triaged_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id,attempt_id) DO UPDATE SET reason_sha256=excluded.reason_sha256, reason=excluded.reason, origin=excluded.origin,
      origin_confidence=excluded.origin_confidence, category=excluded.category, category_confidence=excluded.category_confidence,
      same_rule_id=excluded.same_rule_id, status=excluded.status, detail=excluded.detail, failed_at=excluded.failed_at, triaged_at=excluded.triaged_at`)
    .run(projectId, attempt.attemptId, attempt.runId, attempt.taskId, sha(attempt.reason), attempt.reason.slice(0, 4000),
      result.origin ?? null, result.originConfidence ?? null, result.category ?? null, result.categoryConfidence ?? null, result.sameRuleId ?? null,
      result.status, result.detail ?? null, attempt.failedAt, now);
}

export type TriageSummary = { total: number; byOrigin: Record<string, number>; errors: number; lastTriagedAt: number | null };

export function triageSummary(db: TriageDatabase, projectId: string, since: number): TriageSummary {
  const rows = db.prepare(`SELECT status, origin, count(*) AS n, max(triaged_at) AS last FROM lane_pilot_failure_triage
    WHERE project_id=? AND failed_at>=? GROUP BY status, origin`).all(projectId, since) as Array<{ status: string; origin: string | null; n: number; last: number }>;
  const byOrigin: Record<string, number> = {};
  let total = 0, errors = 0, last: number | null = null;
  for (const row of rows) {
    total += row.n;
    last = Math.max(last ?? 0, row.last);
    if (row.status === "error") errors += row.n;
    else byOrigin[row.origin ?? "unclear"] = (byOrigin[row.origin ?? "unclear"] ?? 0) + row.n;
  }
  return { total, byOrigin, errors, lastTriagedAt: last };
}

export type WriterFailure = { attemptId: string; runId: string; taskId: string; reason: string; threadId: string | null; failedAt: number };
/** `scope` is the section chain the group's rule belongs to, outermost first; empty for the whole project. */
export type WriterGroup = { category: string; taskCount: number; failures: WriterFailure[]; scope: string[] };

/**
 * Writer failures grouped by meaning: one category, at least `minTasks` tasks, none already covered by an
 * existing rule (Jev matched it) or cited as evidence of a proposal. One failure per task, the newest.
 */
export function writerGroups(db: TriageDatabase, projectId: string, since: number, options: { minTasks?: number; minConfidence?: number; chains?: ReadonlyMap<string, readonly string[]> } = {}): WriterGroup[] {
  const minTasks = options.minTasks ?? 3;
  const rows = db.prepare(`SELECT f.attempt_id AS attemptId, f.run_id AS runId, f.task_id AS taskId, f.reason, f.category, f.failed_at AS failedAt, a.thread_id AS threadId,
      r.settings_scopes_json AS scopesJson
    FROM lane_pilot_failure_triage f LEFT JOIN lane_pilot_attempt a ON a.id=f.attempt_id LEFT JOIN lane_pilot_run r ON r.id=f.run_id
    WHERE f.project_id=? AND f.failed_at>=? AND f.status='ok' AND f.origin='writer' AND f.origin_confidence>=? AND f.same_rule_id IS NULL
      AND (f.detail IS NULL OR f.detail<>'model:not_writer')
    ORDER BY f.failed_at DESC`).all(projectId, since, options.minConfidence ?? 0.5) as Array<WriterFailure & { category: string | null; scopesJson: string | null }>;
  const cited = new Set<string>();
  for (const row of db.prepare("SELECT evidence_json FROM lane_pilot_rule_proposal WHERE project_id=?").all(projectId) as Array<{ evidence_json: string }>) {
    try { for (const ref of JSON.parse(row.evidence_json) as Array<{ taskId?: unknown }>) if (typeof ref.taskId === "string") cited.add(ref.taskId); } catch { /* no evidence */ }
  }
  const byCategory = new Map<string, Map<string, { failure: WriterFailure; chain: string[] }>>();
  for (const row of rows) {
    if (cited.has(row.taskId)) continue;
    const category = row.category ?? "other";
    const byTask = byCategory.get(category) ?? new Map<string, { failure: WriterFailure; chain: string[] }>();
    if (!byTask.has(row.taskId)) {
      const stored = options.chains?.get(row.runId);
      let chain: string[] = stored ? [...stored] : [];
      if (!stored) { try { const parsed = JSON.parse(row.scopesJson ?? "[]") as unknown; if (Array.isArray(parsed)) chain = parsed.filter((item): item is string => typeof item === "string"); } catch { /* project root */ } }
      byTask.set(row.taskId, { failure: { attemptId: row.attemptId, runId: row.runId, taskId: row.taskId, reason: row.reason, threadId: row.threadId, failedAt: row.failedAt }, chain });
    }
    byCategory.set(category, byTask);
  }
  const groups: WriterGroup[] = [];
  for (const [category, byTask] of byCategory) {
    // Deepest section first: a section with enough tasks of its own gets its own rule; what is left climbs to the parent.
    let pending = [...byTask.values()];
    const deepest = Math.max(0, ...pending.map((item) => item.chain.length));
    for (let depth = deepest; depth >= 0 && pending.length > 0; depth--) {
      const atDepth = new Map<string, typeof pending>();
      for (const item of pending) {
        if (item.chain.length < depth) continue;
        const key = item.chain.slice(0, depth).join("\u0000");
        atDepth.set(key, [...(atDepth.get(key) ?? []), item]);
      }
      for (const [, items] of atDepth) {
        if (items.length < minTasks) continue;
        groups.push({ category, taskCount: items.length, failures: items.map((item) => item.failure), scope: items[0]!.chain.slice(0, depth) });
        pending = pending.filter((item) => !items.includes(item));
      }
    }
  }
  return groups.sort((a, b) => b.taskCount - a.taskCount);
}
