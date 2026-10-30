import { defineJudgment, noul, noulOf } from "@lane-pilot/jev";

/**
 * Gemini #5: the cheap battery before the plan critic. The planner stays on its role; the heavyweight `plan-critic`
 * agent runs only when the battery cannot certify the plan — one noul per check (decomposition, ordering, coverage,
 * boundaries, contradictions). Every check confident means the graph skips the critic; one unsure answer sends the
 * plan to it, so shadow and an unavailable Jev change nothing.
 */
export const PLAN_CHECK_ID = "plan.check";

export type PlanCheckInput = { goal: string; objective?: string; tasks?: string; task_count?: number | string; has_ui?: boolean | string; median_task?: string };
export type PlanCheckDecision = { battery_ok: boolean; failed: string[] };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const CHECKS = [
  ["decomposed", "Does `plan` break the goal into concrete tasks with file-level intent — not vague restatements of the goal?"],
  ["ordered", "Are the tasks ordered so each can build on the previous ones (waves/dependencies make sense)?"],
  ["covers_goal", "Taken together, do the tasks cover everything `goal` asks for — no requirement left without a task?"],
  ["boundaries", "Do the tasks stay inside the run's boundary (no unrelated refactors, no scope creep)?"],
  ["consistent", "Is the plan free of contradictions — no two tasks doing the same work, no task contradicting the objective?"],
  ["grain", "Given `median_task` (the project's median accepted task size: files, minutes, attempts), are the tasks cut at a comparable grain — not slices far below it? If `median_task` is empty, answer yes."],
] as const;

export const planCheckJudgment = defineJudgment<PlanCheckInput, PlanCheckDecision>({
  id: PLAN_CHECK_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    goal: clip(input.goal ?? "", 1_500),
    objective: clip(input.objective ?? "", 800),
    tasks: clip(input.tasks ?? "", 4_000),
    task_count: String(input.task_count ?? ""),
    has_ui: String(input.has_ui ?? ""),
    median_task: clip(input.median_task ?? "", 300),
  }),
  questions: () => Object.fromEntries(CHECKS.map(([id, question]) => [
    id,
    noul(`${question} Answer from \`goal\`, \`objective\`, \`tasks\`, \`median_task\`.`, { true: "yes", false: "no" }),
  ])),
  thresholds: {
    min_p: { default: 0.75, min: 0.55, max: 0.95, about: "least probability of a check passing before the plan critic is skipped" },
  },
  decide(answers, t) {
    const failed: string[] = [];
    for (const [id] of CHECKS) {
      const p = noulOf(answers, id);
      if (p === undefined) return { escalate: "plan_critic" };
      if (p < t.min_p!) failed.push(id);
    }
    // A failed check means the plan critic reads the plan, not that the plan is rejected — the critic decides.
    return { decision: { battery_ok: failed.length === 0, failed } };
  },
  fallback: () => ({ battery_ok: false, failed: [] }),
  describe: (decision) => (decision.battery_ok ? "battery ok" : `battery failed: ${decision.failed.join(",") || "unsure"}`),
});
