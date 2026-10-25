import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import { getRunSettingsScopes, getTask, latestTaskAttemptState, listOpenAttempts, loadProjectSettings } from "../../storage";
import { taskFamily } from "../../runs";
import { parseSandboxUnsafePatterns } from "../../critique";
import { isTaskSatisfied } from "../../runs/server";
import { lintContract, lintProbePaths, siblingTestFolders } from "./contract-lint";
import { checkProgram } from "../rails";
import { allowedSecretNames } from "../../secrets/server";
import { gateResolverFor } from "../../verification/server";
import { parseIntegrationGateSettings } from "../../verification/server";
import type { LintOpenTask, PathKind } from "./contract-lint";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";

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
    // The file names next to owned code files, for their tests with a longer name (best-effort; an older host without listFolders stays silent).
    let listings:Map<string, string[]> | null = null;
    const folders = siblingTestFolders(task, workspacePath);
    if (folders.length) {
      try {
        const answer = await host.call("listFolders", { requestedHostId:hostId, paths:folders }, { hostId, timeoutMs:15_000 });
        if (Array.isArray(answer?.entries)) listings = new Map(answer.entries.map((entry) => [entry.path, entry.names]));
      } catch { listings = null; }
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
    // Is the check command runnable: the bare programs the checks start, looked up on the writer's machine (best-effort; silent when it cannot be asked).
    let programs:Map<string, boolean> | null = null;
    const wanted = [...new Set(task.verification.map((check) => checkProgram(check.command)).filter((program): program is string => !!program && /^[A-Za-z0-9._+-]{1,80}$/.test(program)))];
    if (wanted.length) {
      try {
        const answer = await host.call("whichPrograms", { requestedHostId:hostId, cwd:workspacePath, programs:wanted }, { hostId, timeoutMs:15_000 });
        programs = new Map(Object.entries(answer.found));
      } catch { programs = null; }
    }
    const ownerWords = String(settings["owner.words"] ?? "off") === "on";
    return lintContract({ task, workspacePath, hostId, kinds, listings, sandboxUnsafe, gate, openTasks, deadDependencies, programs, ownerWords, ...(secrets ? { secrets } : {}) });
  };
}
