/**
 * Propose–Probe–Compose. The night replay (src/rooms/harness/server/probe-run.ts) installs the candidate in a bench
 * checkout of a saved task and runs that task's verification. These helpers only choose the attempts and render the
 * file the composer reads. `enabled: false`, a zero token budget or a zero time budget skips the round.
 */
export type ProbeBudget = {
  maxAttempts: number;
  tokenBudget: number;
  /** Seconds for the whole round. 0 skips. */
  timeBudgetSec?: number;
  /** Off skips the round without touching a host. */
  enabled?: boolean;
};

/** Two attempts, 24k tokens and 20 minutes. A budget of 0, or `enabled: false`, skips the probe. */
export const PROBE_DEFAULTS: ProbeBudget = { maxAttempts: 2, tokenBudget: 24_000, timeBudgetSec: 1200, enabled: true };

export type ProbeSource = { attemptId: string; tokens: number; brief: string; outcome: string };

export type ProbeContrast = { attemptId: string; candidate: string; tokens: number; added: string; outcome: string; passed?: boolean; seconds?: number };

const clipTokens = (text: string, tokens: number): string => {
  const chars = Math.max(0, tokens) * 4;
  const body = text.trim();
  return body.length <= chars ? body : body.slice(0, chars);
};

/**
 * Newest attempts first, at most two, whose token estimates fit the budget. An attempt larger than the whole remaining
 * budget is replayed only when nothing has been picked yet, and then only clipped to that budget.
 */
export function selectProbeAttempts(attempts: readonly ProbeSource[], budget: ProbeBudget = PROBE_DEFAULTS): ProbeSource[] {
  const cap = Math.min(2, Math.max(0, budget.maxAttempts));
  if (budget.enabled === false || cap === 0 || budget.tokenBudget <= 0 || budget.timeBudgetSec === 0) return [];
  const picked: ProbeSource[] = [];
  let spent = 0;
  for (const attempt of attempts) {
    if (picked.length >= cap) break;
    const room = budget.tokenBudget - spent;
    if (room <= 0) break;
    const cost = Math.max(1, attempt.tokens);
    if (cost <= room) {
      picked.push(attempt);
      spent += cost;
      continue;
    }
    if (picked.length === 0) picked.push({ ...attempt, tokens: room });
    break;
  }
  return picked;
}

/** One candidate on one saved attempt. `tokenBudget` is this replay's share; the diff and the outcome each get half. */
export function replayCandidate(input: { label: string; diff: string; attempt: ProbeSource; tokenBudget: number }): ProbeContrast {
  const half = Math.floor(Math.max(0, input.tokenBudget) / 2);
  return {
    attemptId: input.attempt.attemptId,
    candidate: input.label,
    tokens: Math.min(Math.max(1, input.attempt.tokens), Math.max(0, input.tokenBudget)),
    added: clipTokens(input.diff.trim() || "(no difference from the current harness)", half),
    outcome: clipTokens(input.attempt.outcome, half),
  };
}

/** The file the composer reads (`context/probe.md`). Empty when nothing was replayed. */
export function formatProbeContrasts(rows: readonly ProbeContrast[]): string {
  if (!rows.length) return "";
  const lines = ["# Overnight probe", "", "Each candidate below was installed in a bench checkout of a saved task and that task's verification was run. A replay is not a verdict.", ""];
  for (const row of rows) {
    const checks = row.passed === undefined ? "" : `checks: ${row.passed ? "passed" : "failed"}\n`;
    const seconds = row.seconds === undefined ? "" : `seconds: ${row.seconds}\n`;
    lines.push(`## candidate ${row.candidate} on attempt ${row.attemptId} (${row.tokens} tokens)`, "", checks + seconds + "### what the candidate adds", row.added || "(nothing)", "", "### what that attempt did", row.outcome || "(no outcome recorded)", "");
  }
  return lines.join("\n");
}
