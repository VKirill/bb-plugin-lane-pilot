import { z } from "zod";

export const nightReviewResultSchema = z.object({
  decision:z.enum(["clear","findings"]),
  summary:z.string().min(1).max(2000),
  findings:z.array(z.object({
    severity:z.enum(["blocking","warning"]),
    path:z.string().min(1).max(500),
    finding:z.string().min(1).max(1000),
    suggestedFix:z.string().min(1).max(1000),
  }).strict()).max(20),
}).strict().superRefine((value,ctx)=>{
  if(value.decision==="clear"&&value.findings.length>0) ctx.addIssue({code:"custom",message:"clear decision cannot include findings"});
  if(value.decision==="findings"&&value.findings.length===0) ctx.addIssue({code:"custom",message:"findings decision requires at least one finding"});
});

export type NightReviewResult=z.infer<typeof nightReviewResultSchema>;

export function shouldRunNightReview(enabled:unknown):{run:boolean;reason:string|null} {
  if(enabled==null||enabled===false||enabled===0||(typeof enabled==="string"&&["false","off","0","no"].includes(enabled.trim().toLowerCase()))) return {run:false,reason:"disabled_by_project_setting"};
  if(![true,1,"true","on","1","yes"].includes(enabled as never)) return {run:false,reason:"invalid_night_review_enabled_setting"};
  return {run:true,reason:null};
}

export function parseNightReviewResult(raw:string):NightReviewResult {
  const text=raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"");
  return nightReviewResultSchema.parse(JSON.parse(text));
}

export function nightReviewPrompt(input:{agent:string;task:unknown;acceptedResult:unknown;workspace:string;maxFindings:number}):string {
  return [
    `You are the ${input.agent} night review stage for a bounded Lane Pilot task.`,
    "Review the accepted task result and its verification facts. Do not edit files, run commands, or merge anything.",
    `Limit the report to at most ${input.maxFindings} concrete findings. Only report issues within the task contract and affected workspace.`,
    "Return exactly one JSON object matching {decision:'clear'|'findings',summary:string,findings:[{severity:'blocking'|'warning',path:string,finding:string,suggestedFix:string}]}. Use clear with an empty findings array only when no actionable finding exists.",
    `Workspace: ${input.workspace}`,
    "TASK CONTRACT:",JSON.stringify(input.task),
    "ACCEPTED RESULT:",JSON.stringify(input.acceptedResult),
  ].join("\n\n");
}
