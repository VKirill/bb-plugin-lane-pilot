import { choice, choiceOf, defineJudgment } from "@lane-pilot/jev";

/**
 * J-errand: which side of the crystallization list an errand episode's failure is on, asked once per enriched episode in
 * shadow — the receipt lands in lane_pilot_jev_receipt and the nightly outcome labels grade it against the episode's own
 * `failure_class` (packages/jev/src/labels-outcome.ts `labelErrandFailure`). The class list is the errands' own closed
 * set, wider than `failure.class`'s six: it names what an errand can lack (a skill, access, a clear brief) and how the run
 * itself misbehaved (looped, stopped early, never verified, timed out, a tool error).
 */
export const ERRAND_FAILURE_ID = "errand.failure";
export const ERRAND_FAILURE_CLASSES = [
  "no_skill", "skill_not_used", "no_access", "site_changed", "unclear_brief", "ignored_constraint",
  "looped", "stopped_early", "unverified", "timeout", "tool_error", "other",
] as const;
export type ErrandFailureClass = (typeof ERRAND_FAILURE_CLASSES)[number];

export type ErrandFailureInput = {
  status: string; outcome: string; verified: string | null; reason: string;
  actions: number; failed: number; brief: string;
};
export type ErrandFailureDecision = { cls: ErrandFailureClass };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const CRITERIA: Record<ErrandFailureClass, string> = {
  no_skill: "The task needed a skill, playbook or known procedure that does not exist or was never offered to the run.",
  skill_not_used: "A fitting skill was offered or available but the run never opened or invoked it.",
  no_access: "The run lacked access: credentials, permissions, a login, an API key or a seat it needed.",
  site_changed: "The external site, service or API the errand works on changed: layout, endpoints, pricing, rules.",
  unclear_brief: "The brief itself was ambiguous or missing information the run needed to proceed correctly.",
  ignored_constraint: "The run had the information and ignored an explicit constraint, instruction or limit of the brief.",
  looped: "The run repeated the same failing action over and over instead of changing approach.",
  stopped_early: "The run ended after very little work — a couple of actions — without attempting the task.",
  unverified: "The run reported done without checking its own result (no verification step ran).",
  timeout: "The run hit a time or deadline limit before finishing.",
  tool_error: "A tool, command or API the run depended on errored, crashed or returned unusable output.",
  other: "None of the above fits, or the evidence does not say.",
};

export const errandFailureJudgment = defineJudgment<ErrandFailureInput, ErrandFailureDecision>({
  id: ERRAND_FAILURE_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 5_000,
  stateBuilder: (input) => ({
    status: input.status, outcome: input.outcome, verified: input.verified ?? "none",
    actions: input.actions, failed_observations: input.failed, reason: clip(input.reason, 800), brief: clip(input.brief, 1_500),
  }),
  questions: () => ({
    failure: choice(
      "An errand run ended as `outcome` (status `status`, verified `verified`, `actions` tool actions, `failed_observations` failed ones) with reason `reason`. Its masked brief and outcome summary is `brief`. Which single class best names why it failed or fell short? Judge by what the evidence says, not by surface words.",
      CRITERIA,
    ),
  }),
  thresholds: {
    min_p: { default: 0.6, min: 0.4, max: 0.95, about: "least probability of the chosen class" },
    min_margin: { default: 0.2, min: 0.05, max: 0.8, about: "least lead of the chosen class over the runner-up" },
  },
  decide(answers, t) {
    const pick = choiceOf(answers, "failure");
    const cls = pick && pick.p >= t.min_p! && pick.margin >= t.min_margin! && (ERRAND_FAILURE_CLASSES as readonly string[]).includes(pick.top)
      ? pick.top as ErrandFailureClass : "other";
    return { decision: { cls } };
  },
  fallback: () => ({ cls: "other" }),
  describe: (decision) => decision.cls,
});
