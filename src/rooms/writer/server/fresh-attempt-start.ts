import { retargetTask } from "../../tasks";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { resolve } from "node:path";

/** Where a new attempt of the task starts: the run's workspace, whatever worktree a resumed attempt was bound to. */
export function freshAttemptStart(task:TaskV2, config:PrototypeConfig, runWorkspace:string|null):{task:TaskV2;config:PrototypeConfig} {
  if (!runWorkspace || resolve(task.project_cwd) === resolve(runWorkspace)) return { task, config };
  return {
    task:retargetTask(task,runWorkspace),
    config:{...config,writerWorkspacePath:runWorkspace},
  };
}
