import { RULE_FORMS, setRuleForm, type RuleForm, type RulesDatabase } from "@lane-pilot/run-insights";

/**
 * The rules the heuristic could not place (reason «undecided: …») go to System One, one choice question per rule, eight to a call.
 * Cheap: a hub of ~120 live rules leaves ~10 undecided, so one or two calls. A form is taken only when its probability reaches
 * JEV_FORM_MIN_P; anything less keeps the rule as it is (text), which is the status quo and never worse than before.
 */
export const JEV_FORM_MIN_P = 0.5;
const CHUNK = 8;

export type FormAsk = (state: string, questions: Record<string, { instructions: string; criteria: Record<string, string> }>) => Promise<Record<string, Record<string, number>> | null>;

const CRITERIA: Record<RuleForm, string> = {
  check: "check: an automatic check could refuse the mistake: a lint on the task contract, an ownership rule, a verification step or a test",
  hook: "hook: a guard on a tool call or a shell command could block it",
  skill: "skill: procedural knowledge (steps, a craft) that a role should load only when it does this kind of work",
  memory: "memory: a fact about the project, a machine or the owner that is simply true and should be remembered",
  always: "always: a stance for every task that no automatic check, guard or note can hold",
};

export const formQuestion = (rule: string) => ({
  instructions: `A rule written for AI coding agents that work in a software project: «${rule.replace(/\s+/g, " ").trim().slice(0, 600)}». In which form would it be kept so that it is not broken again?`,
  criteria: CRITERIA,
});

export async function jevPickForms(rules: ReadonlyArray<{ id: string; rule: string }>, ask: FormAsk): Promise<Array<{ id: string; form: RuleForm | null; p: number | null }>> {
  const out: Array<{ id: string; form: RuleForm | null; p: number | null }> = [];
  for (let start = 0; start < rules.length; start += CHUNK) {
    const part = rules.slice(start, start + CHUNK);
    const answers = await ask(JSON.stringify({ about: "rules of an orchestrator of AI coding agents" }), Object.fromEntries(part.map((row, index) => [`q${index}`, formQuestion(row.rule)]))).catch(() => null);
    part.forEach((row, index) => {
      const probabilities = answers?.[`q${index}`];
      const ranked = probabilities ? RULE_FORMS.map((form) => [form, probabilities[form]] as const).filter((pair): pair is readonly [RuleForm, number] => typeof pair[1] === "number").sort((a, b) => b[1] - a[1]) : [];
      const top = ranked[0];
      out.push({ id: row.id, form: top && top[1] >= JEV_FORM_MIN_P ? top[0] : null, p: top ? top[1] : null });
    });
  }
  return out;
}

/** Writes Jev's picks for the undecided rules; returns how many moved. */
export async function applyJevForms(db: RulesDatabase, rules: ReadonlyArray<{ id: string; projectId: string; rule: string }>, ask: FormAsk, now = Date.now()): Promise<{ asked: number; moved: number }> {
  const picks = await jevPickForms(rules, ask);
  let moved = 0;
  for (const pick of picks) {
    const row = rules.find((candidate) => candidate.id === pick.id)!;
    if (pick.form && setRuleForm(db, row.projectId, row.id, { form: pick.form, reason: `jev: p=${pick.p!.toFixed(2)} ${pick.form}`, by: "jev" }, now)) moved++;
  }
  return { asked: rules.length, moved };
}
