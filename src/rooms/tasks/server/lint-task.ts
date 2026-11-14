import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import { checkoutBase, getRun, getRunSettingsScopes, getTask, taskBasePath, latestTaskAttemptState, listCheckDurations, listCheckTimeouts, listOpenAttempts, listRunTaskRows, loadProjectSettings } from "../../storage";
import { taskFamily } from "@lane-pilot/contracts";
import { checkoutOwnsOverlap } from "../task-base";
import { QUALITY_MODE_SETTING, resolveQualityMode } from "../../contracts/quality-mode"
import { parseSandboxUnsafePatterns } from "../../contracts/check-commands";
import { lintContract, lintProbePaths, siblingTestFolders } from "./contract-lint";
import { checkProgram, type BirthKind } from "../rails";
import { sha256Hex } from "@lane-pilot/kit";
import type { ReadWriterWorkspaceFile } from "../../platform/server";
import { ownerWordsOn } from "../words";
import { allowedSecretNames } from "../../secrets/server";
import { parseIntegrationGateSettings } from "../../contracts/integration-gate";
import type { LintOpenTask, PathKind } from "./contract-lint";
import type { ServerCore } from "../../contracts/server";

import type { StabilityPort } from "../../contracts/stability-api";
import type { IsTaskSatisfied } from "../../contracts";
import type { VerificationGatePort } from "../../contracts/integration-gate";

/**
 * The designs of a run's live phases, as the phase room keeps them. The phase room imports tasks, never the other way,
 * so it hands its reader in here when its driver starts; before that no phase has drawn for any run.
 */
export type PhaseDesignRead = (projectId:string, runId:string) => Array<{ confirmedAt?:unknown; drawing?:{ paths?:string[]; sha256?:string } | null } | null | undefined>;
const phaseDesigns = new WeakMap<object, PhaseDesignRead>();
export function bindPhaseDesigns(db:object, read:PhaseDesignRead):void { phaseDesigns.set(db, read); }

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  isTaskSatisfied: IsTaskSatisfied;
  stability: StabilityPort;
  resolveIntegrationGate: VerificationGatePort;
  readWriterWorkspaceFile?: ReadWriterWorkspaceFile;
}


/** Gathers the contract lint's inputs for a task; dispatch and lane_pilot_update_task lint a contract with the same rules. */
export function createTaskLinter(ctx: ServerCore, services: Services) {
  const { bb, db, host } = ctx;

  /** The machine's view of the paths, the project's open tasks, and the tasks depends_on names that cannot finish. */
  return async function lintTask(projectId:string, runId:string, task:TaskV2, workspacePath:string, hostId:string, birth?:BirthKind): Promise<ReturnType<typeof lintContract>> {
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
    const base = checkoutBase(getRun(db, runId)?.writer_workspace_path ?? null, task.project_cwd, task.repo_scope === true);
    const openTasks:LintOpenTask[] = [];
    for (const row of listOpenAttempts(db)) {
      if (row.project_id !== projectId || row.task_id === task.id || openTasks.some((open) => open.id === row.task_id)) continue;
      const parsed = taskV2Schema.safeParse(getTask(db, row.task_id)?.contract);
      // Only the tasks this one can share files with: another repository of the BB project is another queue.
      if (!parsed.success || !checkoutOwnsOverlap(base, task.owns_paths, taskBasePath(db, row.run_id, row.task_id), parsed.data.owns_paths)) continue;
      openTasks.push({ id:row.task_id, owns_paths:parsed.data.owns_paths, never_touch:parsed.data.never_touch, depends_on:parsed.data.depends_on });
    }
    const parked = task.depends_on.length ? await services.stability.loadParked() : [];
    const deadDependencies:Array<{ id:string; state:"blocked" | "canceled" }> = [];
    for (const dep of new Set(task.depends_on)) {
      const state = latestTaskAttemptState(db, projectId, dep);
      if (state !== "blocked" && state !== "canceled") continue;
      // Parked for a machinery fault, vouched for by the PM, or restarted under another member of its family: not dead.
      if (parked.some((row) => row.projectId === projectId && taskFamily(row.taskId) === taskFamily(dep))) continue;
      if (state === "blocked" && await services.isTaskSatisfied(bb.storage.kv as never, projectId, dep)) continue;
      deadDependencies.push({ id:dep, state });
    }
    const settings = loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId));
    const sandboxUnsafe = parseSandboxUnsafePatterns(settings["verification.sandbox_unsafe"]);
    const declared = [...new Set(task.verification.flatMap((check) => check.secrets ?? []))];
    // Names only: the lint never reads a value.
    const secrets = declared.length ? await ctx.secrets.check({ declared, allowed:allowedSecretNames(settings) }, { fresh:true }) : undefined;
    // The gate runs in the run's base checkout; its explicit or detected command makes a whole-suite check a contract error.
    const gate = await services.resolveIntegrationGate({ runId, hostId, basePath:workspacePath, gate:parseIntegrationGateSettings(settings) });
    // Is the check command runnable: the bare programs the checks start, looked up on the writer's machine (best-effort; silent when it cannot be asked).
    let programs:Map<string, boolean> | null = null;
    const wanted = [...new Set(task.verification.map((check) => checkProgram(check.command)).filter((program): program is string => !!program && /^[A-Za-z0-9._+-]{1,80}$/.test(program)))];
    if (wanted.length) {
      try {
        const answer = await host.call("whichPrograms", { requestedHostId:hostId, cwd:workspacePath, programs:wanted }, { hostId, timeoutMs:15_000 });
        programs = new Map(Object.entries(answer.found));
      } catch { programs = null; }
    }
    const ownerWords = ownerWordsOn(settings);
    // What the project recorded of each check: its green durations (the store checkTimeoutSec reads) and the limits it timed out at.
    const checkHistory = (check:{ command:string; cwd:string }) => { const ref = { command:check.command, cwd:check.cwd, root:task.project_cwd }; return { greenMs:listCheckDurations(db, projectId, ref), timedOutSec:listCheckTimeouts(db, projectId, ref) }; };
    const qualityMode = resolveQualityMode(task, settings[QUALITY_MODE_SETTING]);
    // A redo gets the gates of the birth it redoes: the family's first task tells it.
    const redoneBirth = birth === "redo" ? (listRunTaskRows(db, runId).find((row) => row.id === taskFamily(task.id))?.birth ?? null) : null;
    // Drawing kinship: the confirmed drawings of this run's open phases, each sha256 recomputed over the files as they are now
    // (a file changed after the confirmation breaks the kinship, as the design gate's own signature does).
    let confirmedDrawings:Array<{ paths:readonly string[]; sha256:string; changed?:boolean }> | undefined;
    if (task.drawing?.length) {
      confirmedDrawings = [];
      const run = getRun(db, runId);
      for (const design of phaseDesigns.get(db)?.(projectId, runId) ?? []) {
        const drawing = design?.drawing;
        if (!design?.confirmedAt || !drawing?.paths?.length || !drawing.sha256) continue;
        // The same signature the design stage recorded (path:sha256 lines); a file that cannot be read now proves nothing either way.
        let changed = false;
        if (run?.pm_thread_id && services.readWriterWorkspaceFile && drawing.paths.length <= 30) {
          const hashes:string[] = [];
          for (const path of drawing.paths) {
            const file = await services.readWriterWorkspaceFile({ threadId: run.pm_thread_id, projectId, path, offset: 0, maxLines: 2000 }).catch(() => null) as { sha256?: string } | null;
            if (!file?.sha256) { hashes.length = 0; break; }
            hashes.push(`${path}:${file.sha256}`);
          }
          changed = hashes.length > 0 && sha256Hex(hashes.join("\n")) !== drawing.sha256;
        }
        confirmedDrawings.push({ paths: drawing.paths, sha256: drawing.sha256, changed });
      }
    }
    return lintContract({ task, workspacePath, hostId, kinds, listings, sandboxUnsafe, gate, openTasks, deadDependencies, programs, ownerWords, qualityMode, checkHistory, birth, redoneBirth, confirmedDrawings,...(secrets ? { secrets } : {}) });
  };
}
