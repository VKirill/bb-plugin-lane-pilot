import { z } from "zod";
import { sha256 } from "./journal";

/**
 * The goals of a run (K7): what the owner agreed the run is for, as the router wrote them (`done_when` says when the goal is
 * met, `evidence` what shows it). They travel with the run: agent briefs are reminded of them (reground), the run is audited
 * against them before it closes (goal audit), and the PM may change them with a reason that stays in the run's journal (amend).
 */
export const goalSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, "goal id: letters, digits, - and _"),
  done_when: z.string().trim().min(3).max(600),
  evidence: z.string().trim().min(3).max(600),
  /** The router inferred it from the request rather than reading it: the owner has not confirmed it. */
  guess: z.boolean().optional(),
}).strict();
export type RunGoal = z.infer<typeof goalSchema>;
export const MAX_GOALS = 8;
export const goalsSchema = z.array(goalSchema).max(MAX_GOALS).superRefine((goals, ctx) => {
  const seen = new Set<string>();
  goals.forEach((goal, index) => { if (seen.has(goal.id)) ctx.addIssue({ code: "custom", message: `goal id "${goal.id}" is used twice`, path: [index, "id"] }); seen.add(goal.id); });
});

export const parseGoals = (text: string | null | undefined): RunGoal[] => {
  if (!text) return [];
  try { const parsed = goalsSchema.safeParse(JSON.parse(text)); return parsed.success ? parsed.data : []; } catch { return []; }
};

/** Which goals a verdict leaves open. */
export type GoalAudit = {
  /** The goals the audit judged. */
  met: string[];
  unmet: Array<{ id: string; why: string }>;
  notes?: string;
};

export const goalsSha = (goals: readonly RunGoal[]): string => sha256(JSON.stringify(goals.map((goal) => [goal.id, goal.done_when, goal.evidence]))).slice(0, 16);

/** The first step, then every third: a long run does not drift away from what it is for. */
export const regroundDue = (stepOrdinal: number): boolean => stepOrdinal === 1 || stepOrdinal % 3 === 0;

/** The block an agent's brief carries when the goals are due: fenced as the owner's words, with what to do about a conflict. */
export function goalsBlock(goals: readonly RunGoal[]): string {
  return [
    "<goals-of-this-run>",
    ...goals.map((goal) => `- ${goal.id}${goal.guess ? " (inferred, not confirmed)" : ""}: done when ${goal.done_when}. Evidence: ${goal.evidence}.`),
    "</goals-of-this-run>",
    "These are what the whole run is for. Check that your step serves them. If the task of this step works against a goal, or a goal cannot be met with what you were given, say so in your handoff instead of working around it.",
  ].join("\n");
}
