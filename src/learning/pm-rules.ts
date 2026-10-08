import { listRuleProposals, scopeApplies, RULE_RELEVANCE_THRESHOLD, type RuleProposal } from "@lane-pilot/run-insights";
import type { Jev } from "../jev/run";
import { defineJudgment, noul, noulOf } from "../jev/registry";
import type { Db } from "./store";
import { ruleTokens } from "./rule-budget";

/**
 * The rules for the PM reach the PM (T4). The map of 2026-10-08 found that rules the owner's corrections produced (`audience` pm or
 * both) were written for writers only: `acceptedRules` ran in the writer's brief and the rule scan, and the PM saw a rule only when it
 * searched memory. Now a PM that starts has its project's rules in its prompt (and a PM session that resumes gets the current ones
 * through `contributeInstructions`, see service.ts), within a token budget:
 *   1. rules marked `always`, 2. rules the owner decided or the trial confirmed, 3. rules on trial, newest first,
 * a rule never cut in the middle. What does not fit is counted, and `lane_pilot_memory {action:"learned", op:"rules", text}` picks the
 * relevant ones for a text with Jev, as the writers' rules are picked for a task.
 */
export type PmRule = Pick<RuleProposal, "id" | "rule" | "always" | "trialState" | "decidedBy" | "decidedAt" | "scope" | "audience">;

const priority = (rule: PmRule): number => (rule.always ? 0 : rule.trialState !== "trial" ? 1 : 2);

/** The project's rules the PM must follow, in the order they are given. */
export function pmRulesOf(db: Db, projectId: string, chain?: readonly string[]): PmRule[] {
  return listRuleProposals(db as never, projectId, { state: "accepted", limit: 500 })
    .filter((rule) => rule.audience !== "writer" && rule.memoryId !== null && (!chain || scopeApplies(rule.scope, chain)))
    .sort((a, b) => priority(a) - priority(b) || (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
}

export type PmRulesBlock = { text: string; shown: number; hidden: number; tokens: number };

export function pmRulesBlock(rules: readonly PmRule[], budgetTokens: number): PmRulesBlock {
  const head = "Rules the owner taught in this project (they came from his corrections; follow them in planning, task contracts, reviews, merges, deploys and in what you ask him):";
  const lines: string[] = [];
  let used = ruleTokens(head);
  for (const rule of rules) {
    const cost = ruleTokens(rule.rule);
    if (used + cost > budgetTokens) continue;
    lines.push(`- ${rule.rule}`);
    used += cost;
  }
  const hidden = rules.length - lines.length;
  if (!lines.length) return { text: "", shown: 0, hidden, tokens: 0 };
  const tail = hidden > 0 ? `\n(${hidden} more rule${hidden === 1 ? "" : "s"} did not fit here: lane_pilot_memory {action:"learned", op:"rules", text:"<what you are about to do>"} lists the ones that apply.)` : "";
  return { text: `\n\n${head}\n${lines.join("\n")}${tail}`, shown: lines.length, hidden, tokens: used };
}

/** The rules block of a PM that is being started for a run (activation.ts); empty when the project has no rule for the PM. */
export function pmRulesPromptBlock(db: Db, projectId: string, chain: readonly string[], budgetTokens: number): string {
  try { return pmRulesBlock(pmRulesOf(db, projectId, chain), budgetTokens).text; } catch { return ""; }
}

/* ---- picking the rules that apply to a text ---- */

export const PM_RULE_RELEVANCE_ID = "learning.pm_rule_relevance";
export type RelevanceInput = { text: string; rules: string[] };

export const pmRuleRelevance = defineJudgment<RelevanceInput, boolean[]>({
  id: PM_RULE_RELEVANCE_ID,
  version: 1,
  defaultMode: "active",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({ situation: input.text }),
  questions: (input) => Object.fromEntries(input.rules.slice(0, 48).map((rule, index) => [`r${index + 1}`, noul(
    "Should the project manager agent be reminded of the rule given here while it handles `situation`? Answer yes when what it is about to do touches what the rule is about.",
    { true: `the rule applies: ${rule.slice(0, 500)}`, false: "the rule is about something else" },
  )])),
  thresholds: { min_p: { default: RULE_RELEVANCE_THRESHOLD, min: 0.01, max: 0.9, about: "least p(yes) for a rule to be shown; low on purpose, a missed rule costs more than an extra line" } },
  decide: (answers, t, input) => ({ decision: input.rules.slice(0, 48).map((_, index) => (noulOf(answers, `r${index + 1}`) ?? 1) >= t.min_p!) }),
  fallback: (input) => input.rules.map(() => true),
  describe: (decision) => `${decision.filter(Boolean).length}/${decision.length}`,
});

/** The rules among `rules` that apply to `text`; every rule when Jev cannot be asked (a missed rule costs more than an extra line). */
export async function relevantPmRules<T extends { rule: string }>(jev: Jev | null, rules: readonly T[], text: string): Promise<T[]> {
  if (!jev || !jev.enabled() || rules.length === 0 || !text.trim()) return [...rules];
  const verdict = await jev.judge(pmRuleRelevance, { text: text.slice(0, 4000), rules: rules.map((rule) => rule.rule) }, { subject: "pm-rules" });
  const picked = verdict.by === "jev" ? verdict.decision : rules.map(() => true);
  return rules.filter((_, index) => picked[index] ?? true);
}
