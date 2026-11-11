import type { ServerCore } from "../../contracts/server";
import type { TaskV2 } from "../../contracts";
import { getTask } from "../../storage";
import { isMainfixTask } from "../../tasks";
import { stringAt } from "@lane-pilot/kit";
import type { Services } from "./integration-gate";

/**
 * The repair task of a red gate traced to one merged task: that task's contract with the gate's command as its check and the fix turn as
 * its objective, dispatched to the run's PM queue (the same «x-mainfix» id the post-merge check uses, so the redispatch and validation rules
 * of a repair apply). Returns the task id, or null when nothing could be dispatched: no contract, no PM chat, a refused dispatch, or a
 * culprit that is itself a repair (main red again after a repair is a person's to read, as checkMainAfterMerge holds).
 */
export async function dispatchRepair(ctx: ServerCore, services: Services, input: { runId: string; projectId: string; pmThreadId: string }, taskId: string, gateCommand: string, prompt: string, logPath: string): Promise<string | null> {
  if (isMainfixTask(taskId) || !input.pmThreadId) return null;
  const contract = getTask(ctx.db as never, taskId)?.contract as TaskV2 | undefined;
  if (!contract || typeof contract !== "object") return null;
  const fix: TaskV2 = { ...contract, id: `${taskId}-mainfix`.slice(0, 128), title: `Make main green after ${taskId}`.slice(0, 200),
    display_title: `Починка main после ${taskId}`.slice(0, 60), kind: "fix", area: contract.area ?? "maintenance", depends_on: [],
    risk: contract.risk === "low" ? "medium" : contract.risk, expected_outputs: [gateCommand], objective: prompt,
    // Each of the culprit's items whole: one string cut at 600 characters left a requirement broken mid-word and the plan critic blocked it.
    acceptance: [`\`${gateCommand}\` passes on main`, ...(contract.acceptance ?? []).map((item) => `${taskId}'s acceptance still holds: ${item}`)] };
  const plan = `Integration gate repair, dispatched by Lane Pilot. Full gate log: ${logPath}. Read the failure, find what ${taskId} clashes with on main, fix within owns_paths, run \`${gateCommand}\`.`;
  try {
    const result = await services.dispatchWriter({ threadId: input.pmThreadId, projectId: input.projectId, task: fix, plan });
    const rejected = (result as { ok?: unknown }).ok === false || (result as { state?: unknown }).state === "rejected";
    return rejected ? null : (stringAt(result, "taskId") ?? fix.id);
  } catch (cause) {
    ctx.log(`integration-gate: repair of ${taskId} not dispatched: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  }
}
