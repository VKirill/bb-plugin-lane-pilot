import { z } from "zod";
import { clipped, extractModelJson, NO_TOOLS_LINE } from "./model-json";

export const specialistResultSchema = z.object({
  decision: z.enum(["approve", "block"]),
  summary: clipped(2000),
  risks: z.array(z.object({
    severity: z.enum(["high", "critical"]),
    path: z.string().min(1).max(500),
    concern: clipped(1000),
    mitigation: clipped(1000),
  }).strict()).max(30),
}).strict();

export type SpecialistResult = z.infer<typeof specialistResultSchema>;

export function specialistPrompt(input:{task:unknown; plan:string; agent?:string}):string {
  return [
    `You are ${input.agent?.trim() || "the specialist risk-review stage"} for a bounded software task.`,
    `Review the task and plan for concrete security, data-loss, compatibility, and recovery risks. ${NO_TOOLS_LINE}`,
    "Answer with one JSON object and nothing else: no text before or after it. Keys: decision (\"approve\" or \"block\"), summary (string, at most 2000 characters), risks (at most 30 objects, each with severity \"high\" or \"critical\", path (at most 500 characters), concern (at most 1000) and mitigation (at most 1000)). Any other key, or a lower severity, makes the answer unreadable and the task is blocked. Use approve with an empty risks array when there is no high or critical risk.",
    "Block only when a concrete high or critical risk has no adequate mitigation in the supplied plan. Do not invent repository facts.",
    "TASK CONTRACT:", JSON.stringify(input.task),
    "CANONICAL PLAN:", input.plan,
  ].join("\n\n");
}

export function parseSpecialistResult(output:string):SpecialistResult {
  return specialistResultSchema.parse(extractModelJson(output));
}

export function shouldRunSpecialist(input:{enabled:unknown; when:unknown; risk:string}):{run:boolean;reason:string|null} {
  const enabled = input.enabled;
  if (enabled == null || enabled === false || enabled === 0 || (typeof enabled === "string" && ["false", "off", "0", "no"].includes(enabled.trim().toLowerCase()))) {
    return {run:false,reason:"disabled_by_project_setting"};
  }
  if (enabled != null && ![true, 1, "true", "on", "1", "yes"].includes(enabled as never)) {
    return {run:false,reason:"invalid_specialist_enabled_setting"};
  }
  const when = input.when == null ? "high_risk" : input.when;
  if (when !== "high_risk" && when !== "always") return {run:false,reason:`unsupported_specialist_when:${String(when)}`};
  return when === "always" || input.risk === "high" || input.risk === "critical"
    ? {run:true,reason:null}
    : {run:false,reason:"risk_below_specialist_threshold"};
}
