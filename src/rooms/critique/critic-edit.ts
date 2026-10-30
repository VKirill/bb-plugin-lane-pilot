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

/** Trial stays closed unless the flag is on and the caller passed a bench. The proposal is not applied either way. */
export function criticEditGate(input: { trialOn: boolean; benchOn: boolean; proposal: string | null }): { status: "held" | "trial" | "skipped"; detail: string } {
  if (!input.proposal) return { status: "skipped", detail: "no critic is below the calibration bar" };
  if (!input.trialOn || !input.benchOn) return { status: "held", detail: "the proposal is stored; the trial stays off until critic.edit.trial is on and a bench is passed in" };
  return { status: "trial", detail: input.proposal };
}

/** KV flag. Absent means off. Set `{ on: true }` to let a run with `bench=on` leave the gate. */
export const CRITIC_EDIT_TRIAL_KEY = "lp.critic.edit.trial";
