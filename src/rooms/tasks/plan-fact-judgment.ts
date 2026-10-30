import { defineJudgment, noul, noulOf } from "@lane-pilot/jev";

/**
 * C4 shadow run: Jev's blind read of the acceptance items against the diff, asked next to the code's plan→fact check and
 * never changing it. Each item is one Noul «does the diff and the check results show this item done?» — the three-valued
 * answer the audit asked for is read from the probability: done / not done / not visible from the diff.
 * Mode `shadow` is the default; nothing it answers can fail or skip the task.
 */
export const PLAN_FACT_JEV_ID = "plan.fact";

export type PlanFactJevInput = {
  acceptance: readonly string[];
  /** The attempt's diff, already clipped and marked `[diff truncated]` when it did not fit. */
  diff: string;
  /** The verification commands that ran and their exit codes. */
  checks: ReadonlyArray<{ command: string; exitCode: number }>;
};
export type PlanFactJevItem = "done" | "not_done" | "unseen";
export type PlanFactJevDecision = { items: Record<number, PlanFactJevItem> };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export const PLAN_FACT_DIFF_CHARS = 40_000;
export const clipDiff = (diff: string): string => (diff.length <= PLAN_FACT_DIFF_CHARS ? diff : `${diff.slice(0, PLAN_FACT_DIFF_CHARS)}\n[diff truncated]`);

export const planFactJudgment = defineJudgment<PlanFactJevInput, PlanFactJevDecision>({
  id: PLAN_FACT_JEV_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  // White list only: the item texts, the clipped diff, the check results — never the writer's prose or task metadata.
  stateBuilder: (input) => ({
    acceptance: input.acceptance.slice(0, 30).map((item, index) => `${index + 1}. ${clip(item, 300)}`),
    diff: clipDiff(input.diff),
    checks: input.checks.slice(0, 20).map((row) => ({ command: clip(row.command, 300), exit_code: row.exitCode })),
  }),
  questions: (input) => Object.fromEntries(input.acceptance.slice(0, 30).map((item, index) => [`item_${index + 1}`, noul(
    `\`acceptance\` item ${index + 1} says: «${clip(item, 300)}». Do \`diff\` and \`checks\` show it is done — implemented or verified by a check that passed? Answer yes only on evidence in the diff or a passing check, no when the diff does the opposite, and no also when the diff simply does not show it.`,
    { true: "the diff or a passing check shows the item done", false: "the diff contradicts it, or nothing shows it" },
  )])),
  thresholds: {
    min_done: { default: 0.6, min: 0.3, max: 0.95, about: "p(done) at which the item counts as done" },
    max_not_done: { default: 0.35, min: 0.05, max: 0.6, about: "p(done) below which the item counts as not done; between the two it is unseen" },
  },
  decide(answers, t, input) {
    const items: Record<number, PlanFactJevItem> = {};
    input.acceptance.slice(0, 30).forEach((_, index) => {
      const p = noulOf(answers, `item_${index + 1}`) ?? 0;
      items[index + 1] = p >= t.min_done! ? "done" : p <= t.max_not_done! ? "not_done" : "unseen";
    });
    return { decision: { items } };
  },
  fallback: (input) => ({ items: Object.fromEntries(input.acceptance.map((_, index) => [index + 1, "unseen" as const])) }),
  describe: (decision) => {
    const groups = ["done", "not_done", "unseen"].map((name) => {
      const items = Object.entries(decision.items).filter(([, verdict]) => verdict === name).map(([item]) => item);
      return items.length ? `${name}:${items.join(",")}` : null;
    }).filter(Boolean);
    return groups.join(" ") || "unseen";
  },
});
