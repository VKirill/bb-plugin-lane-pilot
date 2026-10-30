/** A critic the calibration marked low, plus the misses the proposal can quote. */
export type CriticEditRow = {
  stage: string;
  calibration: { low: boolean; labeled: number; hits: number; byModel: ReadonlyArray<{ model: string; low: boolean }> };
  missed: { examples: ReadonlyArray<{ taskId: string; reason: string }> };
};

/**
 * A prompt edit for a critic whose verdicts do not predict the outcome. Null when none is under the bar.
 * The text is the proposal; nothing here changes a prompt.
 */
export function criticPromptProposal(stats: readonly CriticEditRow[]): string | null {
  const low = stats.filter((row) => row.calibration.low);
  if (!low.length) return null;
  return low.map((row) => {
    const models = row.calibration.byModel.filter((item) => item.low).map((item) => item.model).join(", ") || "the role";
    const misses = row.missed.examples.map((item) => `${item.taskId}: ${item.reason}`).join("; ") || "none recorded";
    return `${row.stage} (${models}) matched ${row.calibration.hits} of ${row.calibration.labeled} outcomes. On the next pass, a fail needs the file and the line of what was missed. Misses: ${misses}.`;
  }).join("\n");
}

/** KV flag. Absent means on. `"off"` or `{ on: false }` holds the proposal. */
export function criticEditTrialOn(stored: unknown): boolean {
  if (stored == null || stored === "") return true;
  if (stored === "off" || stored === false || stored === 0) return false;
  if (typeof stored === "object" && (stored as { on?: unknown }).on === false) return false;
  return true;
}

/**
 * Holds the proposal until the harness bench gate (`judgeSharedTrial`, nightly set, 14-day deadline) adopts.
 * Wait and retire do not change a prompt. Adopt lifts the hold; this function still does not write the prompt.
 */
export function criticEditGate(input: {
  trialOn: boolean;
  proposal: string | null;
  decision: { action: "wait" | "adopt" | "retire"; reason: string };
}): { status: "held" | "trial" | "skipped" | "retired"; detail: string; applyPrompt: boolean } {
  if (!input.proposal) return { status: "skipped", detail: "no critic is below the calibration bar", applyPrompt: false };
  if (!input.trialOn) return { status: "held", detail: "the proposal is stored; critic.edit.trial is off", applyPrompt: false };
  if (input.decision.action === "wait") return { status: "held", detail: input.decision.reason, applyPrompt: false };
  if (input.decision.action === "retire") return { status: "retired", detail: input.decision.reason, applyPrompt: false };
  return { status: "trial", detail: input.proposal, applyPrompt: true };
}

export const CRITIC_EDIT_TRIAL_KEY = "lp.critic.edit.trial";
