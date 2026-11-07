import { estimateTokens } from "@lane-pilot/memory-core";
import { DEFAULT_RULE_TOKENS, RULE_COUNT_CEILING, type RulePool } from "../contracts/rule-budget";

/** What a rule costs beyond its words: the bullet and the line break it is mixed in with. */
const LINE_OVERHEAD = 3;
export const ruleTokens = (rule: string): number => estimateTokens(rule) + LINE_OVERHEAD;
export const poolTokens = (rules: ReadonlyArray<{ rule: string }>): number => rules.reduce((sum, row) => sum + ruleTokens(row.rule), 0);

let budgets: Record<RulePool, number> = { ...DEFAULT_RULE_TOKENS };

export function setRuleBudgets(patch: Partial<Record<RulePool, number>>): void {
  budgets = { ...budgets, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => typeof value === "number" && value > 0)) };
}
export const ruleBudget = (pool: RulePool): number => budgets[pool];

/** Whether a rule of this wording fits next to the rules already in the pool. */
export function poolHasRoom(pool: ReadonlyArray<{ rule: string }>, incoming: string, which: RulePool): boolean {
  return pool.length < RULE_COUNT_CEILING && poolTokens(pool) + ruleTokens(incoming) <= ruleBudget(which);
}
