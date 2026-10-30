import { listRuleProposals } from "@lane-pilot/run-insights";
import type { Jev, JudgeContext } from "@lane-pilot/jev";
import { defineJudgment, noul, noulOf } from "@lane-pilot/jev";
import type { Db } from "./store";

/**
 * abide for Lane Pilot: the accepted project rules that bind writers (audience `writer` or `both`) checked as one
 * Noul per rule against the attempt's diff, before the critic. A violation goes to the writer as a remark in its
 * feedback, never a block; `shadow` (the default) only records what it would have caught.
 */

export const RULE_DIFF_ID = "learning.rule_diff";

/** The project's accepted rules a writer's diff must hold, capped at one judgment's questions. */
export function writerDiffRules(db: Db, projectId: string): string[] {
  return listRuleProposals(db as never, projectId, { state: "accepted", limit: 48 })
    .filter((rule) => rule.audience !== "pm" && rule.memoryId !== null)
    .map((rule) => rule.rule);
}

export type RuleDiffInput = { diff: string; rules: string[] };

export const ruleDiffJudgment = defineJudgment<RuleDiffInput, boolean[]>({
  id: RULE_DIFF_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({ diff: input.diff.slice(0, 40_000) }),
  questions: (input) => Object.fromEntries(input.rules.slice(0, 48).map((rule, index) => [`r${index + 1}`, noul(
    "Does `diff` violate the project rule given here? Answer yes only when the changed lines clearly break it, not when the rule is merely related.",
    { true: `broken rule: ${rule.slice(0, 400)}`, false: "the rule is kept or does not apply to this diff" },
  )])),
  thresholds: {
    min_p: { default: 0.7, min: 0.3, max: 0.98, about: "least p(yes) to name a rule broken; high on purpose, a false alarm costs a writer's attention" },
  },
  decide: (answers, t, input) => ({
    decision: input.rules.slice(0, 48).map((_, index) => (noulOf(answers, `r${index + 1}`) ?? 0) >= t.min_p!),
  }),
  fallback: (input) => input.rules.map(() => false),
  describe: (decision) => `${decision.filter(Boolean).length} broken`,
});

/** The accepted writer rules `diff` breaks, or none — also when Jev is off, in shadow, or it cannot answer. */
export async function judgeRulesOnDiff(
  jev: Jev | null,
  db: Db,
  projectId: string,
  diff: string,
  ctx: JudgeContext = {},
): Promise<string[]> {
  if (!jev || !jev.enabled(ctx.settings) || !diff.trim()) return [];
  const rules = writerDiffRules(db, projectId);
  if (!rules.length) return [];
  const verdict = await jev.judge(ruleDiffJudgment, { diff, rules }, { subject: "rule-diff", ...ctx });
  if (verdict.by !== "jev") return [];
  return rules.filter((_, index) => verdict.decision[index]);
}

/** The remark the writer reads about the rules its change broke (data, never a block). */
export function ruleViolationRemark(rules: readonly string[]): string {
  if (!rules.length) return "";
  return `Project rules your change breaks (a remark, not a block — fix them in place, or say why they do not apply):\n${rules.map((rule) => `- ${rule}`).join("\n")}`;
}
