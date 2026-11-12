import { listRuleProposals, logRulesShown, scopeApplies, type RuleProposal } from "@lane-pilot/run-insights";
import type { Db } from "./store";
import { ruleBudget, ruleTokens } from "./rule-budget";

/**
 * The rules for the PM reach the PM (T4). The map of 2026-10-08 found that rules the owner's corrections produced (`audience` pm or
 * both) were written for writers only: `acceptedRules` ran in the writer's brief and the rule scan, and the PM saw a rule only when it
 * searched memory. Now a PM that starts has its project's rules in its prompt (and a PM session that resumes gets the current ones
 * through `contributeInstructions`, see service.ts), within a token budget:
 *   1. rules marked `always`, 2. rules the owner decided or the trial confirmed, 3. rules on trial, newest first,
 * a rule never cut in the middle. What does not fit is counted, and `lane_pilot_memory {action:"learned", op:"rules", text}` picks the
 * relevant ones for a text by rule (no model), as the writers' rules are picked for a task.
 */
export type PmRule = Pick<RuleProposal, "id" | "rule" | "cue" | "always" | "trialState" | "decidedBy" | "decidedAt" | "scope" | "audience">;

const priority = (rule: PmRule): number => (rule.always ? 0 : rule.trialState !== "trial" ? 1 : 2);

/** The project's rules the PM must follow, in the order they are given. Path selectors apply only when `paths` is passed (a task being read or contracted). */
export function pmRulesOf(db: Db, projectId: string, chain?: readonly string[], paths?: readonly string[]): PmRule[] {
  return listRuleProposals(db as never, projectId, { state: "accepted", limit: 500 })
    .filter((rule) => rule.audience !== "writer" && rule.memoryId !== null && (!chain || scopeApplies(rule.scope, chain, paths)))
    .sort((a, b) => priority(a) - priority(b) || (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
}

export type PmRulesBlock = { text: string; shown: number; hidden: number; tokens: number; /** The rules in the block, for the use record (logRulesShown). */ ids: string[] };

export function pmRulesBlock(rules: readonly PmRule[], budgetTokens: number): PmRulesBlock {
  const head = "Rules the owner taught in this project (they came from his corrections; follow them in planning, task contracts, reviews, merges, deploys and in what you ask him):";
  const lines: string[] = [];
  const ids: string[] = [];
  let used = ruleTokens(head);
  for (const rule of rules) {
    const cost = ruleTokens(rule.rule);
    if (used + cost > budgetTokens) continue;
    lines.push(`- ${rule.rule}`);
    ids.push(rule.id);
    used += cost;
  }
  const hidden = rules.length - lines.length;
  if (!lines.length) return { text: "", shown: 0, hidden, tokens: 0, ids };
  const tail = hidden > 0 ? `\n(${hidden} more rule${hidden === 1 ? "" : "s"} did not fit here: lane_pilot_memory {action:"learned", op:"rules", text:"<what you are about to do>"} lists the ones that apply.)` : "";
  return { text: `\n\n${head}\n${lines.join("\n")}${tail}`, shown: lines.length, hidden, tokens: used, ids };
}

/** The rules block of a PM that is being started for a run (activation.ts); empty when the project has no rule for the PM. `use` (`pm:<runId>`) records the rules it holds as used, once per run. */
export function pmRulesPromptBlock(db: Db, projectId: string, chain: readonly string[], budgetTokens: number, use?: string): string {
  try {
    const block = pmRulesBlock(pmRulesOf(db, projectId, chain), budgetTokens);
    if (use && block.ids.length) logRulesShown(db as never, projectId, block.ids, use);
    return block.text;
  } catch { return ""; }
}

/** The instructions a PM session that starts or resumes gets from `contributeInstructions` (service.ts): the rules block, cut to BB's limit; null when there is none. */
export function pmResumeInstructions(db: Db, projectId: string, chain: readonly string[], use?: string): string | null {
  const rules = pmRulesOf(db, projectId, chain);
  const budget = ruleBudget("pm");
  const chosen: PmRule[] = [];
  // A character slice cut a rule in half (F10-5). A rule that does not fit whole is skipped; a later shorter one still can.
  for (const rule of rules) {
    const text = pmRulesBlock([...chosen, rule], budget).text.trim();
    if (text.length <= 4_000) chosen.push(rule);
  }
  if (use && chosen.length) { try { logRulesShown(db as never, projectId, chosen.map((rule) => rule.id), use); } catch { /* the record is best effort */ } }
  return pmRulesBlock(chosen, budget).text.trim() || null;
}

/* ---- picking the rules that apply to a text ---- */

const STOP = new Set(["that", "this", "with", "from", "must", "should", "always", "never", "when", "before", "after", "have", "will", "your", "into", "than", "then", "они", "это", "для", "что", "как", "или", "если", "надо", "нужно", "всегда", "никогда"]);
const stems = (text: string): Set<string> => new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []).filter((word) => !STOP.has(word)).map((word) => word.slice(0, 5)));

/**
 * The rules among `rules` that apply to `text`, by rule and without a model. The scope (sections) was already applied by `pmRulesOf`.
 * A rule is kept when it is marked `always`, when it has too few distinctive words to compare (a general rule), or when its words
 * (the rule, its cue) share a stem with the text. A missed rule costs more than an extra line, so the test is one shared stem.
 */
export function relevantPmRules<T extends { rule: string; always?: boolean; cue?: string | null }>(rules: readonly T[], text: string): T[] {
  const wanted = stems(text);
  if (!wanted.size) return [...rules];
  return rules.filter((rule) => {
    if (rule.always) return true;
    const own = stems(`${rule.rule} ${rule.cue ?? ""}`);
    if (own.size < 3) return true;
    for (const stem of own) if (wanted.has(stem)) return true;
    return false;
  });
}

import { getRun, getRunWriterHost, listRunTaskSummaries, planningHomeInputs } from "../storage";
import { confirmedPlanningHome } from "../contracts";
import { listPhases, rubricLine } from "../phase";

/**
 * The «Board now» block a resuming PM reads beside its rules (SMA m_cf_prompt): the run's tasks with their state
 * (at most 20, then a count of the rest), and the stage and rubric of the run's open phase. Null when there is no board.
 */
export function pmBoardBlock(db: Db, runId: string): string | null {
  const tasks = listRunTaskSummaries(db as never, runId, 60);
  const phase = listPhases(db as never, { live: true, limit: 200 }).find((row) => row.runId === runId);
  const lines: string[] = [];
  if (tasks.length) {
    lines.push(`Tasks: ${tasks.slice(0, 20).map((task) => `${task.taskId} ${task.state ?? "?"}`).join("; ")}${tasks.length > 20 ? ` (+${tasks.length - 20} more)` : ""}`);
  }
  if (phase) lines.push(`Phase ${phase.id} — ${phase.stage}. ${rubricLine(phase.stage)}`);
  // The standing instructions name `.agents/plans/` and `.agents/todos/`; with a planning home (project.planning_home) those files are there. Unset: no line.
  const run = getRun(db as never, runId);
  const home = run ? confirmedPlanningHome(getRunWriterHost(db as never, runId), planningHomeInputs(db as never, run.project_id)) : null;
  if (home) lines.push(`Planning home: ${home}. Wherever your instructions say .agents/plans, .agents/todos, .agents/planning or .agents/phases, read them under ${home}/.agents/… instead of the checkout. The guard lets your editor write only inside the checkout, so a new todo or note goes through the workflows todo-add and note-add (they write into the home); a plan you write by hand in .agents/plans/ stays in the checkout.`);
  return lines.length ? ["Board now:", ...lines].join("\n") : null;
}
