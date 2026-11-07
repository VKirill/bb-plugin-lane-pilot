
/**
 * How much room rules in force have (T4). The old limit was twelve rules a pool, which refused short rules while room was left and
 * could not tell a one-line rule from a paragraph (319 refusals on the hub in a month, 6 PM rules waiting). A pool now has a budget in
 * tokens, the measure the prompt it goes into is limited by; a count ceiling stays only as a guard against runaway growth. The budgets
 * are set from the learning config (`pmRulesTokens`, `writerRulesTokens`) when the room mounts.
 *
 * Rules are stored as `core` memory records, and the project's core budget (`memory.core_budget`, 3072 tokens by default) holds them
 * together with the maintainer's conventions: a pool that would not fit there is refused by the store, which `adoptRuleProposal` reports
 * as a full pool.
 */
export type RulePool = "pm" | "writer";
export const DEFAULT_RULE_TOKENS: Record<RulePool, number> = { pm: 1600, writer: 1600 };
export const RULE_COUNT_CEILING = 60;

