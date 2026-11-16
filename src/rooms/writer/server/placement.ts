import { resolve } from "node:path";
import type { TaskV2 } from "../../contracts";
import { freeTaskId } from "../../storage";
import type { LanePilotDatabase } from "../../storage";
import { validateTaskV2 } from "../../tasks";
import { canonicalJson } from "./dispatch-guards";

export type TaskPlacement = { task:TaskV2; plan:string; movedInto?:string; repoScope?:{ root:string; section:string; outside:string[] } } | { rejected:string };
export type PreparedPlacement = { placement:TaskPlacement; binding:{ runId:string; hostId:string; runFolder:string; taskId:string; taskJson:string; plan:string } };
export type PlacementInput = { runId:string; hostId:string; runFolder:string; task:unknown; plan:string };
export const placementDriftReason="writer placement changed while Git preflight was running; send the same task again";
type PlaceTask = (runId:string, hostId:string, runFolder:string, task:TaskV2, plan:string)=>Promise<TaskPlacement>;

export function createPlacementReader(db:LanePilotDatabase, placeTask:PlaceTask): (input:PlacementInput)=>Promise<PreparedPlacement|null> {
  return async(input) => {
    if (input.plan.trim().length===0 || !input.task || typeof input.task!=="object" || Array.isArray(input.task) || typeof (input.task as { id?:unknown }).id!=="string") return null;
    const taskId=freeTaskId(db,(input.task as { id:string }).id);
    const valid=validateTaskV2({ ...(input.task as Record<string,unknown>), id:taskId });
    if (!valid.ok) return null;
    return { placement:await placeTask(input.runId,input.hostId,input.runFolder,valid.task,input.plan), binding:{ runId:input.runId, hostId:input.hostId, runFolder:input.runFolder, taskId, taskJson:canonicalJson(valid.task), plan:input.plan } };
  };
}

export function placementMatches(prepared:PreparedPlacement, input:{runId:string;hostId:string;runFolder:string;taskId:string;task:TaskV2;plan:string}):boolean {
  const binding=prepared.binding;
  return binding.runId===input.runId && binding.hostId===input.hostId && resolve(binding.runFolder)===resolve(input.runFolder)
    && binding.taskId===input.taskId && binding.taskJson===canonicalJson(input.task) && binding.plan===input.plan;
}
