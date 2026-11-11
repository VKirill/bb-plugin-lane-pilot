/**
 * Which accepted rules a writer should read for one task. Recalibrated 2026-10-03 on 75 SelfyStudio contracts
 * and 8 task-dependent rules, each pair labelled by a separate reviewer, System One asked three times: p(yes)
 * reads low on conditional rules («on error X do Y»), so 0.3 missed a third of the needed ones on unseen tasks.
 * At 0.06 recall is 0.95 and precision 0.63 over the two calibration sets — a missed rule costs more than an
 * extra line. Report: `.bb/chats/thr_tev4nistgf/artifacts/rule-eval/REPORT.md`.
 */
export const RULE_RELEVANCE_THRESHOLD = 0.06;

export function ruleRelevanceState(task: Record<string, unknown>): Record<string, unknown> {
  const commands = (Array.isArray(task.verification) ? task.verification as Array<{ command?: unknown }> : [])
    .map((row) => row.command).filter((command) => typeof command === "string");
  return { task: {
    title: task.title, objective: typeof task.objective === "string" ? task.objective.slice(0, 1200) : null,
    owns_paths: task.owns_paths, expected_outputs: task.expected_outputs, acceptance: task.acceptance,
    interfaces: task.interfaces, invariants: task.invariants, read_first: task.read_first, verification_commands: commands,
  } };
}

/** One yes/no question per rule, keyed `r1`…`rN` in the order of `rules`. */
export function ruleRelevanceQuestions(rules: ReadonlyArray<{ rule: string }>): Record<string, { instructions: string; criteria: Record<string, string> }> {
  return Object.fromEntries(rules.map((row, index) => [`r${index + 1}`, {
    instructions: "Should a writer working on this task be reminded of this project rule? Answer yes only when the task's own work or its verification commands touch what the rule is about.",
    criteria: { yes: `the rule applies to this task: ${row.rule}`.slice(0, 500), no: "the rule is about something this task does not do" },
  }]));
}

/**
 * Rules whose probability of «yes» reaches the threshold; an unanswered rule is kept. The threshold was
 * calibrated on System One's `probabilities.yes`; its `confidence` is a different number (0.03 where p(yes)
 * is 0.51), so it is only the fallback of a host that does not return probabilities.
 */
export function pickRelevantRules<T>(rules: readonly T[], answers: Record<string, string>, confidence: Record<string, number>,
  threshold = RULE_RELEVANCE_THRESHOLD, probabilities: Record<string, Record<string, number>> = {}): T[] {
  return rules.filter((_, index) => {
    const key = `r${index + 1}`;
    const yes = probabilities[key]?.yes;
    if (typeof yes === "number") return yes >= threshold;
    const choice = answers[key];
    if (choice !== "yes" && choice !== "no") return true;
    const sure = confidence[key] ?? 1;
    return (choice === "yes" ? sure : 1 - sure) >= threshold;
  });
}
