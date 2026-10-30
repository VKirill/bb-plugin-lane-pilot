/**
 * Propose–Probe–Compose. Before a composer merges candidate harnesses, each candidate is replayed on one or two saved
 * attempts of the same key. The replay is the stored attempt (its brief and outcome) read against the candidate diff,
 * clipped to the round's token budget, so the composer gets a contrast the same night.
 *
 * ponytail: this does not start a second writer. The ceiling is a static replay of a saved attempt. The upgrade is a
 * sandbox writer on the same brief, still capped by `tokenBudget`.
 */
export type ProbeBudget = { maxAttempts: number; tokenBudget: number };

/** Two attempts, 24k tokens for the round. A budget of 0 skips the probe. */
export const PROBE_DEFAULTS: ProbeBudget = { maxAttempts: 2, tokenBudget: 24_000 };

export type ProbeSource = { attemptId: string; tokens: number; brief: string; outcome: string };

export type ProbeContrast = { attemptId: string; candidate: string; tokens: number; added: string; outcome: string };

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
  if (cap === 0 || budget.tokenBudget <= 0) return [];
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
  const lines = ["# Overnight probe", "", "Each candidate below was replayed on a saved attempt of this key. A contrast is not a verdict.", ""];
  for (const row of rows) {
    lines.push(`## candidate ${row.candidate} on attempt ${row.attemptId} (${row.tokens} tokens)`, "", "### what the candidate adds", row.added || "(nothing)", "", "### what that attempt did", row.outcome || "(no outcome recorded)", "");
  }
  return lines.join("\n");
}
