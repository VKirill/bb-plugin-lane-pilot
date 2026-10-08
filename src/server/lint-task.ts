import { taskV2Schema } from "../contracts";
import type { TaskV2 } from "../contracts";
import { getRunSettingsScopes, getTask, latestTaskAttemptState, listOpenAttempts, loadProjectSettings } from "../database";
import { taskFamily } from "../failure-class";
import { parseSandboxUnsafePatterns } from "../stages/critique-coverage";
import { isTaskSatisfied } from "./blocked-by";
import { lintContract, lintProbePaths } from "./contract-lint";
import { allowedSecretNames } from "./secrets";
import { gateResolverFor } from "./gate-detect";
import { parseIntegrationGateSettings } from "./integration-gate";
import type { LintOpenTask, PathKind } from "./contract-lint";
import type { ServerCore } from "./core";
import type { Services } from "./services";

/** Gathers the contract lint's inputs for a task; dispatch and lane_pilot_update_task lint a contract with the same rules. */
export function createTaskLinter(ctx: ServerCore, services: Services) {
  const { bb, db, host } = ctx;

  /** The machine's view of the paths, the project's open tasks, and the tasks depends_on names that cannot finish. */
  return async function lintTask(projectId:string, runId:string, task:TaskV2, workspacePath:string, hostId:string): Promise<ReturnType<typeof lintContract>> {
    let kinds:Map<string, PathKind> | null = null;
    const probes = lintProbePaths(task, workspacePath);
    if (probes.length) {
      try {
        const snapshot = await host.call("snapshotDryRun", { requestedHostId:hostId, paths:probes }, { hostId, timeoutMs:15_000 });
        // A symlink to a file counts as that file (AGENTS.md → CLAUDE.md); one to a folder as a folder; a dangling one stays a symlink.
        kinds = new Map(snapshot.entries.map((entry) => [entry.path, entry.kind === "symlink" && entry.targetKind && entry.targetKind !== "missing" ? entry.targetKind : entry.kind]));
      } catch {
        // Listing is best-effort; a spawn still fail-closes on a read_first it cannot read.
      }
    }
    const openTasks:LintOpenTask[] = [];
    for (const row of listOpenAttempts(db)) {
      if (row.project_id !== projectId || row.task_id === task.id || openTasks.some((open) => open.id === row.task_id)) continue;
      const parsed = taskV2Schema.safeParse(getTask(db, row.task_id)?.contract);
      if (parsed.success) openTasks.push({ id:row.task_id, owns_paths:parsed.data.owns_paths, never_touch:parsed.data.never_touch, depends_on:parsed.data.depends_on });
    }
    const parked = task.depends_on.length ? await services.stability.loadParked() : [];
    const deadDependencies:Array<{ id:string; state:"blocked" | "canceled" }> = [];
    for (const dep of new Set(task.depends_on)) {
      const state = latestTaskAttemptState(db, projectId, dep);
      if (state !== "blocked" && state !== "canceled") continue;
      // Parked for a machinery fault, vouched for by the PM, or restarted under another member of its family: not dead.
      if (parked.some((row) => row.projectId === projectId && taskFamily(row.taskId) === taskFamily(dep))) continue;
      if (state === "blocked" && await isTaskSatisfied(bb.storage.kv as never, projectId, dep)) continue;
      deadDependencies.push({ id:dep, state });
    }
    const settings = loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId));
    const sandboxUnsafe = parseSandboxUnsafePatterns(settings["verification.sandbox_unsafe"]);
    const declared = [...new Set(task.verification.flatMap((check) => check.secrets ?? []))];
    // Names only: the lint never reads a value.
    const secrets = declared.length ? await ctx.secrets.check({ declared, allowed:allowedSecretNames(settings) }, { fresh:true }) : undefined;
    // The gate runs in the run's base checkout; its explicit or detected command makes a whole-suite check a contract error.
    const gate = await gateResolverFor(ctx)({ runId, hostId, basePath:workspacePath, gate:parseIntegrationGateSettings(settings) });
    return lintContract({ task, workspacePath, hostId, kinds, sandboxUnsafe, gate, openTasks, deadDependencies, ...(secrets ? { secrets } : {}) });
  };
}
