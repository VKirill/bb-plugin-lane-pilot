import type { FailureClass } from "../../failure-class";
import { choice, choiceOf, defineJudgment } from "../registry";

/**
 * J-4: which side a failure is on, when the regular expressions of `failureClass` have no confident match. They know the reasons
 * Lane Pilot writes itself; a reason from a tool, a provider or a check that they have never seen falls through to `task`, which
 * charges one of the task's two attempts and sends a writer again, even when the cause is the machine or Lane Pilot (the
 * audit's «wrong parking»). This asks Jev once per such reason and returns one of the six classes a reason can be told apart by.
 *
 * `decide` takes the top class only when it is clear (probability and lead over the runner-up); anything else is `task`, the
 * default the code always had. The classes with a meaning of their own (judgment, limit, budget) stay with the expressions.
 */
export const FAILURE_CLASS_ID = "failure.class";
export const JUDGED_CLASSES = ["task", "provider", "harness", "infra", "merge", "contract"] as const;
export type JudgedClass = (typeof JUDGED_CLASSES)[number];

export type FailureClassInput = { state: string; reason: string };
export type FailureClassDecision = { cls: FailureClass };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const failureClassJudgment = defineJudgment<FailureClassInput, FailureClassDecision>({
  id: FAILURE_CLASS_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 5_000,
  stateBuilder: (input) => ({ attempt_state: input.state, reason: clip(input.reason, 1_500) }),
  questions: () => ({
    side: choice(
      "A writer attempt of a coding task ended in `attempt_state` with `reason`. Which side failed? Decide by what the reason says broke, not by words that merely appear in a log.",
      {
        task: "The task's own work: the code or tests the writer produced are wrong, incomplete or red, a file it had to produce is missing. Another turn of a writer can fix it.",
        provider: "The model provider: rate limit, quota, outage, a model that is unavailable or timed out, an empty answer because the provider failed.",
        harness: "Lane Pilot's own code: an internal error, an illegal state change, a crash in its tooling, a bug in how it prepared or read the attempt. No writer can fix it.",
        infra: "The machine or network: disk full, a git lock, the host offline, a permission error of the machine, a timeout of a host call, a connection reset.",
        merge: "Merging into main: main moved or edits conflict in the same files.",
        contract: "The task's contract or plan cannot be met whatever the writer does: a path or output the contract names is impossible or not owned, a dependency ended, the owner has to decide.",
      },
    ),
  }),
  thresholds: {
    min_p: { default: 0.7, min: 0.5, max: 0.98, about: "least probability of the chosen class" },
    min_margin: { default: 0.3, min: 0.05, max: 0.9, about: "least lead of the chosen class over the runner-up" },
  },
  decide(answers, t) {
    const pick = choiceOf(answers, "side");
    if (!pick || pick.p < t.min_p! || pick.margin < t.min_margin!) return { decision: { cls: "task" } };
    const cls = (JUDGED_CLASSES as readonly string[]).includes(pick.top) ? pick.top as JudgedClass : "task";
    return { decision: { cls } };
  },
  fallback: () => ({ cls: "task" }),
  describe: (decision) => decision.cls,
});
