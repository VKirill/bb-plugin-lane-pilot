import { z } from "zod";
import { clipped, extractModelJson, NO_TOOLS_LINE } from "../critique/model-json";
import { STAGE_IDS } from "../tasks/contract";
import type { GateReport } from "../tasks/gate-report";

export const gateTriageResultSchema=z.object({
  decision:z.enum(["clear","recommendations"]),
  summary:clipped(2000),
  recommendations:z.array(z.object({
    stageId:z.enum(STAGE_IDS),
    state:z.enum(["failed","blocked"]),
    count:z.number().int().min(1).max(1000000),
    action:clipped(1000),
  }).strict()).max(12),
}).strict().superRefine((value,ctx)=>{
  if(value.decision==="clear"&&value.recommendations.length>0) ctx.addIssue({code:"custom",message:"clear decision cannot include recommendations"});
  if(value.decision==="recommendations"&&value.recommendations.length===0) ctx.addIssue({code:"custom",message:"recommendations decision requires at least one recommendation"});
});

export type GateTriageResult=z.infer<typeof gateTriageResultSchema>;

export function gateTriagePrompt(report:GateReport):string {
  return [
    "You are Lane Pilot's read-only gate-triage stage.",
    "Analyze only the supplied project-local aggregate stage event report. It contains no source files or task text.",
    `Do not claim a root cause that these counts cannot establish. Give bounded next diagnostic actions tied to exact stage IDs and failed/blocked counts. Do not edit, execute, repair, merge, or ask for secrets. ${NO_TOOLS_LINE}`,
    `Answer with one JSON object and nothing else: no text before or after it. Keys: decision ("clear" or "recommendations"), summary (string, at most 2000 characters), recommendations (at most 12 objects, each with stageId (exactly one of: ${STAGE_IDS.join(", ")}), state ("failed" or "blocked"), count (integer from 1: the count in the report), action (at most 1000 characters)). A stageId outside that list makes the whole answer unreadable. Use clear and an empty recommendations list when the report has no failed/blocked events; recommendations needs at least one object.`,
    "PROJECT-LOCAL AGGREGATE REPORT:",JSON.stringify(report),
  ].join("\n\n");
}

export function parseGateTriageResult(raw:string):GateTriageResult {
  return gateTriageResultSchema.parse(extractModelJson(raw));
}
