import { defineJudgment, jev, noul, noulOf, type JudgeContext } from "@lane-pilot/jev";

/**
 * `regress.meant`: did the task bisect blamed deliberately remove or change what the red check pins? Asked in the stale
 * sweep of the regression pass, once per culprit (the answer is kept in the row's evidence). At p ≥ 0.9 the row closes
 * itself — a meant change is not a regression (the cab-editor hints of SelfyStudio, removed on purpose by a later task,
 * held every task touching editor.html, 2026-11-02). Below the threshold the row stays open and the probability goes
 * into its note. No Jev (off, no key, a failure) leaves the row open: never guessed.
 */
export const REGRESS_MEANT_ID = "regress.meant";

export type MeantInput = {
  /** The broken task's objective (what the check was written to prove). */
  objective: string;
  /** The failing check command. */
  command: string;
  /** The tail of its last red output. */
  output: string;
  /** The culprit task's contract: objective and acceptance, as stored for its attempt. */
  culpritContract: string;
};

export type MeantVerdict = { meant: boolean; p: number };

export const meantJudgment = defineJudgment<MeantInput, MeantVerdict>({
  id: REGRESS_MEANT_ID,
  version: 1,
  defaultMode: "active",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    original_task_objective: input.objective.slice(0, 3_000),
    failing_check_command: input.command.slice(0, 1_000),
    failing_check_output_tail: input.output.slice(-1_500),
    culprit_task_contract: input.culpritContract.slice(0, 4_000),
  }),
  questions: () => ({
    meant: noul("The check of `original_task_objective` (`failing_check_command`) is red because of `culprit_task_contract`. " +
      "Did the culprit task deliberately remove or change what the check pins — e.g. its contract says the thing the check " +
      "asserts must go, be renamed or be replaced — rather than breaking it by accident?"),
  }),
  thresholds: { min_p: { default: 0.9, min: 0.5, max: 0.99, about: "least p(meant) to close the row; below, it stays open and the p is noted" } },
  decide: (answers, t) => {
    const p = noulOf(answers, "meant") ?? 0;
    return { decision: { meant: p >= t.min_p!, p } };
  },
  fallback: () => ({ meant: false, p: 0 }),
  describe: (decision) => `meant=${decision.meant} p=${decision.p.toFixed(2)}`,
});

/**
 * The verdict on one open regression row, or null when Jev cannot be asked (not installed, off, a failure) — the caller
 * leaves the row open and never guesses. A shadow verdict is not a verdict: it is only recorded, not acted on.
 */
export async function judgeMeant(input: MeantInput, ctx: JudgeContext = {}): Promise<MeantVerdict | null> {
  const instance = jev();
  if (!instance?.enabled(ctx.settings)) return null;
  const verdict = await instance.judge(meantJudgment, input, ctx).catch(() => null);
  return verdict?.by === "jev" ? verdict.decision : null;
}
