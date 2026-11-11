import { listRegressions, type RegressionRecord } from "../../baseline";
import { ownsPathsOverlap } from "@lane-pilot/kit";
import { openDatabase, taskBasePath } from "../../storage";

/** The open found regression a task waits for: same checkout, shared files. Another repository of the project only shares
 * names like package.json (BB-сервис keeps dozens of plugin repos: office-viewer's release checks held magicseo, 2026-10-30). */
export function quarantiningRegression(db:ReturnType<typeof openDatabase>, task:{projectId:string;runId:string;taskId:string;ownsPaths:string[];fixesRegressions?:number[]}, filesOf:(row:RegressionRecord)=>string[]):RegressionRecord|undefined {
  const base = taskBasePath(db, task.runId, task.taskId);
  // A task that names the rows it fixes (contract fixes_regressions) is not held by them — it is the fix; every other row still holds it.
  const fixes = task.fixesRegressions ?? [];
  return listRegressions(db, { projectId:task.projectId }).find((row) => row.kind === "regression" && row.bisectStatus === "found"
    && !fixes.includes(row.id)
    && (!base || taskBasePath(db, row.runId, row.taskId) === base) && ownsPathsOverlap(task.ownsPaths, filesOf(row)));
}
