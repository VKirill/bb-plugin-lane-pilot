import { reasonForStatus } from "@lane-pilot/workflow-engine";
import type { Verdict, VerdictStatus } from "@lane-pilot/workflow-engine";


/**
 * What a critic that did not pass tells the PM. A rework is the existing path (the PM fixes the plan, the writer fixes the
 * code) and keeps its reason; a block stops the task and carries the verdict's own message, in the receipt and in the reason.
 */
export function verdictReasons(result:{status?:VerdictStatus;summary?:string;verdict?:Verdict}, stage:"plan-critique"|"code-critique"|"specialist-review"):{receipt:string;returned:string} {
  const rework = { receipt:stage === "specialist-review" ? "specialist_review_blocked" : "critique_changes_requested", returned:`${stage.replace("-","_")}_blocked` };
  if (result.status !== "block") return rework;
  const text = reasonForStatus("block", stage, result, rework.returned);
  return { receipt:text, returned:text };
}

