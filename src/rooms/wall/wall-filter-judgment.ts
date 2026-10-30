import { choice, choiceOf, defineJudgment } from "@lane-pilot/jev";
import { redactKnownDeep } from "@lane-pilot/kit";

/**
 * Jev judgment for filtering wall failure signatures before spawning the 3-hunter swarm (`lp.wall-hunt`).
 * Separates actionable codebase defects from external infrastructure noise (provider rate limits, outages,
 * network resets, ENOSPC/disk full, git locks) and exact duplicate fingerprints.
 *
 * Conservative decision: only clear, high-confidence noise/duplicate picks are skipped; any uncertain or
 * borderline case falls back to running the hunters as before.
 * Default mode: shadow (receipts recorded, existing behavior preserved until switched to active).
 */
export const WALL_FILTER_ID = "wall.hunt_filter";

export type WallFilterAction = "hunt" | "skip";
export type WallFilterCategory = "actionable" | "infra_noise" | "duplicate" | "uncertain" | "fallback";

export type WallFilterInput = {
  wallKey: string;
  subject: string;
  kind: "class" | "task";
  facts?: readonly string[];
  reasons?: readonly string[];
  checkOutputs?: readonly string[];
};

export type WallFilterDecision = {
  action: WallFilterAction;
  category: WallFilterCategory;
  reason: string;
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Strict whitelist state builder: explicit field selection with no spread operator,
 * clipped string bounds and secret redaction.
 */
export function buildWallFilterState(input: WallFilterInput): Record<string, unknown> {
  const state = {
    wall_key: clip(input.wallKey ?? "", 120),
    subject: clip(input.subject ?? "", 200),
    kind: input.kind,
    facts: (input.facts ?? []).slice(0, 5).map((f) => clip(f, 200)),
    reasons: (input.reasons ?? []).slice(0, 5).map((r) => clip(r, 300)),
    check_outputs: (input.checkOutputs ?? []).slice(0, 3).map((c) => clip(c, 300)),
  };
  return redactKnownDeep(state);
}

export const wallFilterJudgment = defineJudgment<WallFilterInput, WallFilterDecision>({
  id: WALL_FILTER_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 5_000,
  stateBuilder: (input) => buildWallFilterState(input),
  questions: () => ({
    triage: choice(
      "A night loop is deciding whether to spend tokens and run 3 model hunters on an automated failure in `subject` with `reasons`. Decide whether this failure is an actionable repository code defect, or external infrastructure noise / duplicate fingerprint.",
      {
        hunt: "An actionable defect in repository code, tests, contracts or configuration that hunters can investigate and repair in this codebase.",
        infra_noise: "External infrastructure noise: model provider failure/rate limit/quota, host disconnect, ENOSPC (disk full), git index lock, network reset, or system crash. Not fixable by changing project code.",
        duplicate: "An exact repeat of a transient failure or duplicate fingerprint that has already been recorded and offers no new actionable code evidence.",
      },
    ),
  }),
  thresholds: {
    min_p: { default: 0.8, min: 0.5, max: 0.99, about: "least probability to classify as infra noise or duplicate" },
    min_margin: { default: 0.35, min: 0.05, max: 0.9, about: "least margin over the runner-up" },
  },
  decide(answers, t) {
    const pick = choiceOf(answers, "triage");
    if (!pick || pick.p < t.min_p! || pick.margin < t.min_margin!) {
      return { decision: { action: "hunt", category: "uncertain", reason: "uncertain pick: proceed to hunters" } };
    }
    if (pick.top === "infra_noise") {
      return { decision: { action: "skip", category: "infra_noise", reason: `high-confidence infra noise (${pick.p.toFixed(2)})` } };
    }
    if (pick.top === "duplicate") {
      return { decision: { action: "skip", category: "duplicate", reason: `high-confidence duplicate fingerprint (${pick.p.toFixed(2)})` } };
    }
    return { decision: { action: "hunt", category: "actionable", reason: `actionable code defect (${pick.p.toFixed(2)})` } };
  },
  fallback: () => ({ action: "hunt", category: "fallback", reason: "fallback: proceed to hunters" }),
  describe: (decision) => `${decision.action}:${decision.category}`,
});
