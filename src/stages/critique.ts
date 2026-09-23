import { z } from "zod";

export const critiqueResultSchema = z.object({
  decision: z.enum(["approve", "changes_requested"]),
  summary: z.string().min(1).max(2000),
  findings: z.array(z.object({
    severity: z.enum(["info", "warning", "blocking"]),
    finding: z.string().min(1).max(1000),
    criterion: z.string().min(1).max(500),
  }).strict()).max(30),
}).strict();

export type CritiqueResult = z.infer<typeof critiqueResultSchema>;

export function critiquePrompt(input: { plan:string; task:unknown }): string {
  return [
    "You are the independent plan-critique stage for a bounded software task.",
    "Review the plan against the supplied task contract. Do not execute tools or modify files.",
    "Return exactly one JSON object matching this schema: {decision:'approve'|'changes_requested',summary:string,findings:[{severity:'info'|'warning'|'blocking',finding:string,criterion:string}]}.",
    "Use changes_requested only for a concrete missing, contradictory, unsafe, or unverifiable requirement. Do not invent criteria.",
    "TASK CONTRACT:", JSON.stringify(input.task),
    "CANONICAL PLAN:", input.plan,
  ].join("\n\n");
}

export function parseCritique(output: string): CritiqueResult {
  const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return critiqueResultSchema.parse(JSON.parse(trimmed));
}
