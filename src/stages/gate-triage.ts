import { z } from "zod";
import { STAGE_IDS } from "./contract";
import type { GateReport } from "./gate-report";

export const gateTriageResultSchema=z.object({
  decision:z.enum(["clear","recommendations"]),
  summary:z.string().min(1).max(2000),
  recommendations:z.array(z.object({
    stageId:z.enum(STAGE_IDS),
    state:z.enum(["failed","blocked"]),
    count:z.number().int().min(1).max(1000000),
    action:z.string().min(1).max(1000),
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
    "Do not claim a root cause that these counts cannot establish. Give bounded next diagnostic actions tied to exact stage IDs and failed/blocked counts. Do not edit, execute, repair, merge, or ask for secrets.",
    "Return exactly one JSON object matching {decision:'clear'|'recommendations',summary:string,recommendations:[{stageId:string,state:'failed'|'blocked',count:integer,action:string}]}. Use clear and an empty recommendations list when the report has no failed/blocked events.",
    "PROJECT-LOCAL AGGREGATE REPORT:",JSON.stringify(report),
  ].join("\n\n");
}

export function parseGateTriageResult(raw:string):GateTriageResult {
  const text=raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"");
  return gateTriageResultSchema.parse(JSON.parse(text));
}
