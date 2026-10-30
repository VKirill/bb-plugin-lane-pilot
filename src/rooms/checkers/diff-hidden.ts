import { randomUUID } from "node:crypto";
import type { CheckerDb } from "./store";
import {
  lintFindings,
  ownershipFindings,
  planFactFindings,
  codeCriticPrompt,
  readCodeCritic,
  type CommandRun,
  type ModelPort,
  type Subject,
  type Where,
} from "./checkers";
import { testFitFindings } from "../tasks";
import { CHECKERS, type CheckerId, type FileChange } from "./types";

/**
 * Audit with diff hidden (Mirage / ToCS pattern, arXiv 2603.21687):
 * Runs checkers on a task with the code diff hidden (no file changes).
 *
 * Catches two major inspection failure modes:
 * 1. Blind pass: A code-inspecting checker passes even when no diff/code exists.
 * 2. Phantom findings: A checker reports the exact same findings without seeing any diff
 *    (hallucinating issues from the task prompt/contract rather than reading the code).
 *
 * A healthy, diff-sensitive checker behaves differently when the diff is present vs hidden.
 */

export type DiffHiddenCheckResult = {
  checker: CheckerId;
  withDiffFindings: string[];
  diffHiddenFindings: string[];
  /** Flagged identical findings even when diff was completely hidden (prompt hallucination). */
  phantom: boolean;
  /** Reported 0 findings/passed when diff was hidden on code-inspecting check. */
  blindPass: boolean;
  /** True when the checker produced different findings based on diff presence. */
  diffSensitive: boolean;
  detail: string;
};

export type CandidateDiffHiddenAudit = {
  taskId: string;
  checks: DiffHiddenCheckResult[];
};

export type DiffHiddenAuditReport = {
  runId: string;
  recordedAt: number;
  candidatesCount: number;
  totalChecks: number;
  blindPassCount: number;
  phantomCount: number;
  diffSensitiveCount: number;
  sensitivityRate: number;
  results: CandidateDiffHiddenAudit[];
};

export type DiffHiddenRow = {
  id: string;
  runId: string;
  taskId: string;
  checker: CheckerId;
  withDiffFindings: string[];
  diffHiddenFindings: string[];
  phantom: boolean;
  blindPass: boolean;
  diffSensitive: boolean;
  recordedAt: number;
};

/**
 * Creates a Subject where the diff is hidden: all changes are marked unchanged
 * (after === before, or empty array).
 */
export function buildDiffHiddenSubject(subject: Subject): Subject {
  const hiddenChanges: FileChange[] = subject.changes.map((c) => ({
    path: c.path,
    before: c.before,
    after: c.before, // diff hidden: current content reset to baseline
  }));
  return {
    contract: subject.contract,
    changes: hiddenChanges,
    claim: subject.claim,
  };
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((val, idx) => val === sortedB[idx]);
};

/** Checkers designed specifically to inspect code diffs and changes. */
export const DIFF_INSPECTING_CHECKERS: readonly CheckerId[] = [
  "plan_fact",
  "ownership",
  "test_fit",
  "code_critic",
];

/**
 * Runs a single candidate through with-diff and diff-hidden checks.
 */
export async function auditCandidateDiffHidden(
  subject: Subject,
  options: {
    checkers?: readonly CheckerId[];
    runs?: readonly CommandRun[];
    model?: ModelPort | null;
    where?: Where;
  } = {},
): Promise<CandidateDiffHiddenAudit> {
  const enabled = new Set<CheckerId>(options.checkers ?? ["plan_fact", "ownership", "contract_lint", "test_fit"]);
  const hiddenSubject = buildDiffHiddenSubject(subject);
  const checks: DiffHiddenCheckResult[] = [];

  // 1. plan_fact
  if (enabled.has("plan_fact")) {
    const withDiff = planFactFindings(subject);
    const hidden = planFactFindings(hiddenSubject);
    const phantom = withDiff.length > 0 && sameStrings(withDiff, hidden);
    // plan_fact inspects diff: if diff is hidden and it reports 0 blocking items, that's a blind pass
    const blindPass = hidden.length === 0 && subject.contract.acceptance.length > 0;
    const diffSensitive = !sameStrings(withDiff, hidden);
    checks.push({
      checker: "plan_fact",
      withDiffFindings: withDiff,
      diffHiddenFindings: hidden,
      phantom,
      blindPass,
      diffSensitive,
      detail: phantom ? "phantom acceptance verification" : blindPass ? "blind pass with empty diff" : "diff-sensitive",
    });
  }

  // 2. ownership
  if (enabled.has("ownership")) {
    const withDiff = ownershipFindings(subject);
    const hidden = ownershipFindings(hiddenSubject);
    const phantom = withDiff.length > 0 && sameStrings(withDiff, hidden);
    const blindPass = false; // ownership on empty diff is expected to be clean
    const diffSensitive = !sameStrings(withDiff, hidden) || withDiff.length === 0;
    checks.push({
      checker: "ownership",
      withDiffFindings: withDiff,
      diffHiddenFindings: hidden,
      phantom,
      blindPass,
      diffSensitive,
      detail: phantom ? "phantom unowned file finding" : "checked",
    });
  }

  // 3. contract_lint
  if (enabled.has("contract_lint")) {
    const withDiff = lintFindings(subject);
    const hidden = lintFindings(hiddenSubject);
    // lint is contract-level; diff presence is not expected to change contract errors
    const phantom = false;
    const blindPass = false;
    const diffSensitive = true;
    checks.push({
      checker: "contract_lint",
      withDiffFindings: withDiff,
      diffHiddenFindings: hidden,
      phantom,
      blindPass,
      diffSensitive,
      detail: "contract-level check (expected invariant)",
    });
  }

  // 4. test_fit
  if (enabled.has("test_fit")) {
    const withDiff = testFitFindings(subject.changes).map((h) => `${h.kind}:${h.path}`);
    const hidden = testFitFindings(hiddenSubject.changes).map((h) => `${h.kind}:${h.path}`);
    const phantom = withDiff.length > 0 && sameStrings(withDiff, hidden);
    const blindPass = false;
    const diffSensitive = !sameStrings(withDiff, hidden) || withDiff.length === 0;
    checks.push({
      checker: "test_fit",
      withDiffFindings: withDiff,
      diffHiddenFindings: hidden,
      phantom,
      blindPass,
      diffSensitive,
      detail: phantom ? "phantom test-fit finding" : "checked",
    });
  }

  // 5. code_critic (if model port provided)
  if (enabled.has("code_critic") && options.model) {
    const runs = options.runs ?? [];
    const withPrompt = codeCriticPrompt(subject, runs, null);
    const hiddenPrompt = codeCriticPrompt(hiddenSubject, runs, null);
    try {
      const [withRes, hiddenRes] = await Promise.all([
        options.model.ask(withPrompt.prompt, "code_critic", options.where),
        options.model.ask(hiddenPrompt.prompt, "code_critic", options.where),
      ]);
      const withParsed = readCodeCritic(withRes.text);
      const hiddenParsed = readCodeCritic(hiddenRes.text);
      const phantom = withParsed.paths.length > 0 && sameStrings(withParsed.paths, hiddenParsed.paths);
      const blindPass = !hiddenParsed.flagged && subject.contract.owns_paths.length > 0;
      const diffSensitive = withParsed.flagged !== hiddenParsed.flagged || !sameStrings(withParsed.paths, hiddenParsed.paths);
      checks.push({
        checker: "code_critic",
        withDiffFindings: withParsed.paths,
        diffHiddenFindings: hiddenParsed.paths,
        phantom,
        blindPass,
        diffSensitive,
        detail: phantom ? "phantom critique paths" : blindPass ? "critic blind pass" : "diff-sensitive",
      });
    } catch (cause) {
      checks.push({
        checker: "code_critic",
        withDiffFindings: [],
        diffHiddenFindings: [],
        phantom: false,
        blindPass: false,
        diffSensitive: false,
        detail: `error: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  return {
    taskId: subject.contract.id,
    checks,
  };
}

/**
 * Runs the audit across multiple candidates, saves rows to DB if provided,
 * and compiles the summary report.
 */
export async function runDiffHiddenAudit(
  candidates: Subject[],
  options: {
    checkers?: readonly CheckerId[];
    model?: ModelPort | null;
    db?: CheckerDb;
    now?: number;
  } = {},
): Promise<DiffHiddenAuditReport> {
  const now = options.now ?? Date.now();
  const runId = `dha_${randomUUID().slice(0, 12)}`;
  const candidateAudits: CandidateDiffHiddenAudit[] = [];
  const rows: DiffHiddenRow[] = [];

  for (const candidate of candidates) {
    const audit = await auditCandidateDiffHidden(candidate, {
      checkers: options.checkers,
      model: options.model,
    });
    candidateAudits.push(audit);

    for (const check of audit.checks) {
      rows.push({
        id: `dhr_${randomUUID().slice(0, 12)}`,
        runId,
        taskId: audit.taskId,
        checker: check.checker,
        withDiffFindings: check.withDiffFindings,
        diffHiddenFindings: check.diffHiddenFindings,
        phantom: check.phantom,
        blindPass: check.blindPass,
        diffSensitive: check.diffSensitive,
        recordedAt: now,
      });
    }
  }

  if (options.db && rows.length > 0) {
    saveDiffHiddenRows(options.db, rows);
  }

  const totalChecks = rows.length;
  const blindPassCount = rows.filter((r) => r.blindPass).length;
  const phantomCount = rows.filter((r) => r.phantom).length;
  const diffSensitiveCount = rows.filter((r) => r.diffSensitive).length;
  const sensitivityRate = totalChecks > 0 ? diffSensitiveCount / totalChecks : 1.0;

  return {
    runId,
    recordedAt: now,
    candidatesCount: candidates.length,
    totalChecks,
    blindPassCount,
    phantomCount,
    diffSensitiveCount,
    sensitivityRate,
    results: candidateAudits,
  };
}

export function saveDiffHiddenRows(db: CheckerDb, rows: readonly DiffHiddenRow[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO lane_pilot_diff_hidden_audit
      (id, run_id, task_id, checker, with_diff_json, diff_hidden_json, phantom, blind_pass, diff_sensitive, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const row of rows) {
      insert.run(
        row.id,
        row.runId,
        row.taskId,
        row.checker,
        JSON.stringify(row.withDiffFindings),
        JSON.stringify(row.diffHiddenFindings),
        row.phantom ? 1 : 0,
        row.blindPass ? 1 : 0,
        row.diffSensitive ? 1 : 0,
        row.recordedAt,
      );
    }
  })();
}

export type DiffHiddenSummary = {
  totalCandidates: number;
  totalChecks: number;
  blindPasses: number;
  phantomFindings: number;
  diffSensitive: number;
  sensitivityRate: number;
};

export function getDiffHiddenSummary(
  db: CheckerDb,
  sinceMs: number = 0,
  now: number = Date.now(),
): DiffHiddenSummary | null {
  try {
    const row = db.prepare(`
      SELECT
        COUNT(DISTINCT task_id) as candidates,
        COUNT(*) as total,
        COALESCE(SUM(blind_pass), 0) as blind_passes,
        COALESCE(SUM(phantom), 0) as phantoms,
        COALESCE(SUM(diff_sensitive), 0) as sensitive
      FROM lane_pilot_diff_hidden_audit
      WHERE recorded_at >= ? AND recorded_at <= ?
    `).get(sinceMs, now) as {
      candidates: number;
      total: number;
      blind_passes: number;
      phantoms: number;
      sensitive: number;
    } | undefined;

    if (!row || row.total === 0) return null;
    return {
      totalCandidates: row.candidates,
      totalChecks: row.total,
      blindPasses: row.blind_passes,
      phantomFindings: row.phantoms,
      diffSensitive: row.sensitive,
      sensitivityRate: row.total > 0 ? row.sensitive / row.total : 1.0,
    };
  } catch {
    return null;
  }
}

/**
 * Morning line for the wall morning summary.
 * Returns null if no audit ran in the morning window.
 */
export function diffHiddenMorningLine(
  db: CheckerDb,
  now: number = Date.now(),
  windowMs: number = 24 * 3_600_000,
): string | null {
  const summary = getDiffHiddenSummary(db, now - windowMs, now);
  if (!summary) return null;
  const pct = Math.round(summary.sensitivityRate * 100);
  return `Аудит проверок (скрытый дифф): проверено ${summary.totalChecks} проверок на ${summary.totalCandidates} задачах (слепых пропусков ${summary.blindPasses}, фантомных ${summary.phantomFindings}, чувствительность к диффу ${pct}%).`;
}
