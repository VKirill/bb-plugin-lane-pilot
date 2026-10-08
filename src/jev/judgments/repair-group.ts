import { choice, choiceOf, defineJudgment } from "../registry";

/**
 * J-10: which known self-repair group a new incident belongs to. Self-repair keys a problem by `reasonSignature` (the reason with
 * ids, paths and numbers blanked), so one root cause that words its reason in several ways becomes several signatures: 148 on the
 * hub on 2026-10-08, 132 of them never taken, against a limit of 4 repairs a day. This asks Jev, for a signature seen for the first
 * time, whether it is another occurrence of one of the kinds already known (of the same incident kind), or a new problem.
 *
 * The deterministic answer is the one the code always gave: the incident's own signature (a new group). In `shadow` the question
 * is asked and recorded in a receipt and nothing changes; in `active` a clear pick files the incident under the known group, so
 * its count and samples add to that group and one repair thread serves both wordings.
 */
export const REPAIR_GROUP_ID = "selfrepair.group";
export const NEW_GROUP = "new_problem";
export const MAX_CANDIDATES = 10;

export type RepairGroupCandidate = { signature: string; text: string; count: number };
export type RepairGroupInput = { kind: string; reason: string; candidates: RepairGroupCandidate[] };
/** The known group's signature to file the incident under, or null for a group of its own. */
export type RepairGroupDecision = { signature: string | null };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const optionId = (index: number): string => `g${index}`;

export const repairGroup = defineJudgment<RepairGroupInput, RepairGroupDecision>({
  id: REPAIR_GROUP_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 6_000,
  stateBuilder: (input) => ({ kind: input.kind, incident: clip(input.reason, 800) }),
  questions: (input) => {
    const options: Record<string, unknown> = {};
    input.candidates.slice(0, MAX_CANDIDATES).forEach((candidate, index) => { options[optionId(index)] = `${clip(candidate.text, 300)} (seen ${candidate.count} times)`; });
    options[NEW_GROUP] = "A different problem: none of the known ones has the same cause in Lane Pilot.";
    return {
      group: choice(
        "`incident` is a failure line from Lane Pilot (kind in `kind`). Which of the known problems is it another occurrence of? Judge by the cause in Lane Pilot's code or its machine, not by shared words: the same cause worded with other paths, ids, counts or names is the same problem; a different cause that fails in a similar place is not. Pick new_problem when no known problem has this cause.",
        options,
      ),
    };
  },
  thresholds: {
    min_p: { default: 0.75, min: 0.6, max: 0.98, about: "least probability of the known group before the incident is filed under it" },
    min_margin: { default: 0.3, min: 0.05, max: 0.9, about: "least lead of the known group over the runner-up (new_problem included)" },
  },
  decide(answers, t, input) {
    const pick = choiceOf(answers, "group");
    // Unclear is never a reason to merge two problems: a group of its own is what the code did before.
    if (!pick || pick.top === NEW_GROUP || pick.p < t.min_p! || pick.margin < t.min_margin!) return { decision: { signature: null } };
    const index = Number(pick.top.slice(1));
    const candidate = Number.isInteger(index) ? input.candidates[index] : undefined;
    return { decision: { signature: candidate?.signature ?? null } };
  },
  fallback: () => ({ signature: null }),
  describe: (decision) => (decision.signature ? `known:${decision.signature.slice(0, 60)}` : "new"),
});
