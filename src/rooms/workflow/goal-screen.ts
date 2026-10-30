import { defineJudgment, noul, noulOf } from "@lane-pilot/jev";

/**
 * Gemini #4: the cheap checklist before the goal auditor. For every goal (at most 8) one noul — is its `done_when`
 * plainly proven by the run's evidence (merged commits, the writer's summary, git's proof currency); one noul for the
 * whole — is the delivered work the request's intent. Every goal settled (clearly met or clearly not) is Jev's audit;
 * a single unclear one escalates the whole audit to the auditor agent, exactly as without the screen.
 *
 * Runs in shadow by default: the fallback claims nothing is settled, so `goal-screen.value.settled` is only ever true
 * on a verdict Jev itself gave — the auditor keeps running until a project activates the judgment.
 */
export const GOAL_SCREEN_ID = "close.goal_screen";
const MAX_GOALS = 8;

export type GoalScreenInput = {
  goals: Array<{ id: string; done_when: string; evidence?: string }>;
  merged_commits?: string;
  summary?: string;
  proof_currency?: string;
};

export type GoalScreenDecision = {
  settled: boolean; goals: Array<{ id: string; met: boolean }>; all_met: boolean; unmet_ids: string[];
  intent_aligned: boolean; drift_items: unknown[];
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const NEUTRAL: GoalScreenDecision = { settled: false, goals: [], all_met: true, unmet_ids: [], intent_aligned: true, drift_items: [] };

export const goalScreenJudgment = defineJudgment<GoalScreenInput, GoalScreenDecision>({
  id: GOAL_SCREEN_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    goals: clip(JSON.stringify((input.goals ?? []).slice(0, MAX_GOALS).map((goal) => ({ id: goal.id, done_when: goal.done_when, evidence: goal.evidence ?? "" }))), 4_000),
    merged_commits: clip(input.merged_commits ?? "", 2_000),
    summary: clip(input.summary ?? "", 2_000),
    proof_currency: clip(input.proof_currency ?? "", 1_500),
  }),
  questions: (input) => {
    const out: Record<string, ReturnType<typeof noul>> = {};
    for (const [index, goal] of (input.goals ?? []).slice(0, MAX_GOALS).entries()) {
      out[`goal_${index}`] = noul(
        `In the run described by \`goals\`, \`merged_commits\`, \`summary\` and \`proof_currency\`, is the done_when of goal "${goal.id}" proven by evidence (a command output, a file:line, a test result) that exists — not merely claimed?`,
        { true: "evidence exists and proves it", false: "not proven, or proven wrong" },
      );
    }
    out.intent = noul("Does the delivered work (`merged_commits`, `summary`) do what the run's goal asked, with no unrelated changes mixed in?", { true: "yes, it is what was asked", false: "it missed the point or carried unrelated work" });
    return out;
  },
  thresholds: {
    min_p: { default: 0.75, min: 0.55, max: 0.95, about: "least probability for «met» or «unmet»; between the two the auditor decides" },
    min_intent: { default: 0.6, min: 0.4, max: 0.95, about: "least probability of «intent aligned»; below it the run is drift" },
  },
  decide(answers, t, input) {
    const goals: Array<{ id: string; met: boolean }> = [];
    for (const [index, goal] of (input.goals ?? []).slice(0, MAX_GOALS).entries()) {
      const p = noulOf(answers, `goal_${index}`);
      if (p === undefined || (p < t.min_p! && p > 1 - t.min_p!)) return { escalate: "auditor" };
      goals.push({ id: goal.id, met: p >= t.min_p! });
    }
    const intent = noulOf(answers, "intent");
    if (intent === undefined) return { escalate: "auditor" };
    const unmet_ids = goals.filter((goal) => !goal.met).map((goal) => goal.id);
    return { decision: { settled: true, goals, all_met: unmet_ids.length === 0, unmet_ids, intent_aligned: intent >= t.min_intent!, drift_items: [] } };
  },
  fallback: () => NEUTRAL,
  describe: (decision) => (decision.settled ? `${decision.goals.length} goals settled (${decision.unmet_ids.length} unmet)` : "not settled"),
});
