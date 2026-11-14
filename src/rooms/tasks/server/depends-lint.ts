import { cycleText, findCycle } from "../dep-graph";
import { dependsOnTask } from "../depends";

/**
 * A dependency cycle is a plan error before dispatch (owner's rule, ТЗ 4д; SMA p2_waves): a task that names itself, or closes a loop
 * through the open tasks of its run, would wait forever — nothing is queued. A redispatch counts as its name (`P1` names `P1.2`).
 */
export function dependsLoopFindings(task:{ id:string; depends_on:readonly string[] }, runTasks?:ReadonlyArray<{ id:string; depends_on:readonly string[] }>):Array<{ code:string; message:string; data?:Record<string, unknown> }> {
  if (dependsOnTask(task.depends_on, task.id)) return [{ code:"depends_self", message:`depends_on names the task itself (${task.id}), so it would wait for itself forever; remove it from depends_on` }];
  if (!runTasks || !task.depends_on.length) return [];
  const cycle = findCycle([{ id:task.id, depends_on:task.depends_on }, ...runTasks], (dep, id) => dependsOnTask([dep], id));
  if (!cycle?.includes(task.id)) return [];
  const from = cycle.indexOf(task.id);
  const path = [...cycle.slice(from, -1), ...cycle.slice(0, from), task.id];
  return [{ code:"depends_cycle", data:{ replan:true }, message:`depends_on closes a cycle with the open tasks of this run (${cycleText(path)}), so none of them could start; drop the depends_on that is not a real output dependency` }];
}
