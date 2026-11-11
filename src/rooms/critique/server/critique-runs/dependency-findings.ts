import { dependsOnTask } from "../../../tasks";
import type { CoverageFinding } from "../../critique-coverage";

/** depends_on that can never be satisfied: the task names itself, or an open task of the project that waits for it back. */
export function dependencyFindings(task:{id:string;depends_on?:readonly string[]},open:readonly {id:string;depends_on?:readonly string[]}[]):CoverageFinding[] {
  const path=`tasks/${task.id}/depends_on`,found:CoverageFinding[]=[];
  if(dependsOnTask(task.depends_on,task.id))
    found.push({code:"depends_self",path,severity:"error",finding:`Task ${task.id} lists itself in depends_on, so it would wait for itself forever; remove that entry`});
  const seen=new Set([task.id]);
  const walk=(node:{depends_on?:readonly string[]},trail:string[]):string[]|null=>{
    for(const next of open.filter((row)=>!seen.has(row.id)&&(node.depends_on??[]).some((dep)=>dependsOnTask([dep],row.id)))) {
      if(dependsOnTask(next.depends_on,task.id))return [...trail,next.id];
      seen.add(next.id);
      const cycle=walk(next,[...trail,next.id]);if(cycle)return cycle;
    }
    return null;
  };
  const cycle=walk(task,[]);
  if(cycle)found.push({code:"depends_cycle",path,severity:"error",
    finding:`Task ${task.id} depends_on ${cycle[0]}, and ${[...cycle,task.id].join(" -> ")} closes a loop of open tasks, so none of them can start; drop one depends_on edge`});
  return found;
}
