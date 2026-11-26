import { clip } from "@lane-pilot/contracts";

export const WORD_OPTIONS = ["yes", "no"] as const;
export const wordDecisionId = (runId: string, family: string) => `words:${runId}:${family}`;
export type WordTask = { title: string; risk?: string; objective?: string; invariants?: readonly string[] };

export function wordSituation(task: WordTask, family: string): Record<string, unknown> {
  return { question: "land this verified task on main?", task: clip(task.title, 300), risk: task.risk ?? null, objective: clip(task.objective ?? "", 600), invariants: (task.invariants ?? []).slice(0, 6), family };
}
