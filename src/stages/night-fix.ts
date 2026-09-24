import { posix } from "node:path";
import { findUnownedChanges, type OwnershipTask } from "../verification/ownership";
import type { NightReviewResult } from "./night";

export type NightFixPlan = { findings:NightReviewResult["findings"]; paths:string[] };

export function buildNightFixPlan(review:NightReviewResult, task:OwnershipTask, maxFixTasks=5):NightFixPlan {
  const limit=Math.max(1,Math.min(10,Number.isFinite(maxFixTasks)?Math.trunc(maxFixTasks):5));
  const findings=review.findings.filter((finding)=>finding.severity==="blocking"||finding.severity==="warning").slice(0,limit);
  if(!findings.length) throw new Error("night_review_has_no_actionable_findings");
  const paths=[...new Set(findings.map((finding)=>{
    const raw=finding.path.trim();
    if(!raw||raw.includes("\\")||raw.startsWith("/")||/^[A-Za-z]:/.test(raw)) throw new Error(`night_review_unsafe_path:${raw||"<empty>"}`);
    const normalized=posix.normalize(raw);
    if(normalized==="."||normalized===".."||normalized.startsWith("../")||normalized.split("/").includes("..")) throw new Error(`night_review_unsafe_path:${raw}`);
    if(findUnownedChanges([normalized],task).length) throw new Error(`night_review_finding_outside_owned_paths:${normalized}`);
    return normalized;
  }))].sort();
  return {findings,paths};
}

export function nightFixPrompt(input:{task:unknown;findings:NightFixPlan["findings"];paths:string[]}):string {
  return [
    "Apply only the bounded fixes described below to the listed owned paths.",
    "Do not edit any other file, change task scope, commit, push, or merge. If the finding cannot be fixed safely within these paths, explain why and make no out-of-scope change.",
    `Allowed paths: ${input.paths.join(", ")}`,
    "TASK CONTRACT:",JSON.stringify(input.task),
    "NIGHT REVIEW FINDINGS:",JSON.stringify(input.findings),
    "Finish with a concise summary of edits and any remaining limitation.",
  ].join("\n\n");
}

export type NightMergePrerequisites={
  explicitlyEnabled:unknown;
  fixState:string;
  verificationPassed:boolean;
  managedWorktree:boolean;
  pullRequestOutcome:"available"|"absent"|"unavailable";
  pullRequestState?:string;
  attention?:string;
  checksState?:string;
  reviewState?:string;
  mergeability?:string;
};

export function decideNightMerge(input:NightMergePrerequisites):{merge:boolean;reason:string} {
  if(input.explicitlyEnabled!==true) return {merge:false,reason:"merge_not_explicitly_authorized"};
  if(input.fixState!=="passed") return {merge:false,reason:"verified_night_fix_required"};
  if(!input.verificationPassed) return {merge:false,reason:"verification_not_passed"};
  if(!input.managedWorktree) return {merge:false,reason:"managed_worktree_required"};
  if(input.pullRequestOutcome!=="available") return {merge:false,reason:`pull_request_${input.pullRequestOutcome}`};
  if(input.pullRequestState!=="open"||input.attention!=="ready_to_merge") return {merge:false,reason:"pull_request_not_ready"};
  if(input.checksState!=="passing"||input.reviewState!=="approved"||input.mergeability!=="mergeable") return {merge:false,reason:"pull_request_checks_review_or_mergeability_not_approved"};
  return {merge:true,reason:"explicit_policy_and_verified_pull_request_ready"};
}
