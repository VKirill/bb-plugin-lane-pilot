import { isAbsolute, relative, resolve } from "node:path";
import type { TaskV2 } from "../contracts";

/**
 * Where a verification command runs when the task moves to another checkout of the same project (an attempt's worktree, main
 * again for the post-merge check). The command's folder inside the project stays: `/p/apps/marketing` becomes
 * `<workspace>/apps/marketing`; a relative cwd is read against the workspace. Null when the cwd is outside the project.
 * Every move used to set the cwd to the workspace root, so `npx vitest run tests/fitness/` of apps/marketing ran from the repo
 * root and failed with ENOENT (live 2026-10-09).
 */
export function mapVerificationCwd(cwd: string, fromRoot: string, toRoot: string): string | null {
  const from = resolve(fromRoot);
  const rel = relative(from, isAbsolute(cwd) ? resolve(cwd) : resolve(from, cwd));
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel ? resolve(toRoot, rel) : resolve(toRoot);
}

/** The task as it runs in `root`: project_cwd is `root` and each check keeps its folder inside the project. */
export function retargetTask(task: TaskV2, root: string): TaskV2 {
  return {
    ...task,
    project_cwd: root,
    // A cwd outside the project cannot reach here (the contract lint refuses it); the workspace root is the safe place if it did.
    verification: task.verification.map((command) => ({ ...command, cwd: mapVerificationCwd(command.cwd, task.project_cwd, root) ?? root })),
  };
}
