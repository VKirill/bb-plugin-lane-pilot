import type { openDatabase } from "../../../storage";
import { closeWriterStages } from "../../../runs/server";
import { DISPATCH_IDEMPOTENT_WINDOW_MS } from "../../../runs";
import type { TaskV2 } from "../../../contracts";
import { getRun, getRunWriterHost, getTaskPlan, getTaskRow, hasFailedStageReceipt, listAttemptsForTask, listOpenAttempts, listRunTaskRows, listStageReceipts, setRunState, transitionAttempt } from "../../../storage";
import { commonTaskFolder, isMainfixTask, isTaskBase, leavesSection, normalizeRepoReads, parseReadFirstHints, parseReadFirstSelector, parseRepoTop, planWithOutsideReads, planWithRepoScope, repoTopCommand, rerootTask, rerootToRepoRoot } from "../../../tasks";
import { repoReadRoot, sha256 } from "../../../tasks/server";
import { taskFamily } from "@lane-pilot/contracts";
import { bestEffort, stringAt, valueAt } from "@lane-pilot/kit";
import { canonicalJson } from "./dispatch-guards";
import type { TaskPlacement } from "./placement";
import { isAbsolute, relative, resolve } from "node:path";
import type { ServerCore } from "../../../contracts/server";
import { runOnHost } from "@lane-pilot/host-calls";
import type { Services } from "./dispatch";

export function createDispatchPlacement({ ctx, db: _db, services }: { ctx: ServerCore; db: ReturnType<typeof openDatabase>; services: Services }) {
  void _db;
  const { bb, db, host, refreshRun } = ctx;
  function failDispatch(runId:string, taskId:string, attemptId:string, plan:string, cause:unknown): Record<string,unknown> {
    const reason = `dispatch_failed:${cause instanceof Error ? cause.message : String(cause)}`;
    bb.log.warn(`Lane Pilot dispatch of ${taskId} failed: ${reason}`);
    transitionAttempt(db, attemptId, "blocked", { reason });
    closeWriterStages(db, { runId, taskId, plan, terminal:"failed", attempt:0, reason });
    setRunState(db, runId, "blocked");
    refreshRun(runId);
    return { runId, taskId, attemptId, state:"blocked", reason, stages:listStageReceipts(db, runId, taskId) };
  }

  async function readWriterWorkspaceFile(args:{
    threadId:string; projectId:string; path:string; offset:number; maxLines:number;
  }): Promise<Record<string, unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    const run = getRun(db, runId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId) {
      throw new Error("run does not belong to this PM thread and project");
    }
    const hostId = getRunWriterHost(db, runId);
    const workspacePath = run.writer_workspace_path;
    if (!hostId || !workspacePath) throw new Error("run has no frozen writer host or workspace binding");
    const selected = parseReadFirstSelector(args.path);
    let root = workspacePath;
    let path = args.path;
    if (selected.scope === "repo") {
      const hint = parseReadFirstHints([args.path])[0]!;
      if (hint.windows.length) throw new Error("lane_pilot_read_path_escaped_workspace");
      const found = await repoReadRoot(host, hostId, workspacePath, [args.path]);
      if (!found) throw new Error("lane_pilot_read_repo_unknown");
      root = found.root;
      path = selected.path;
    }
    if (path.includes("\0") || isAbsolute(path)) throw new Error("lane_pilot_read_path_escaped_workspace");
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("lane_pilot_read_path_escaped_workspace");
    const file = await host.call("readBoundedFile", {
      requestedHostId: hostId,
      projectCwd: root,
      relativePath: rel.split("\\").join("/"),
      offset: args.offset,
      maxLines: args.maxLines,
    }, { hostId, timeoutMs: 15_000 });
    if (file.hostId !== hostId) throw new Error("lane_pilot_read_host_mismatch");
    return file;
  }

  /** An open or accepted task of this run with the same id, contract and plan, created in the last 30 minutes. */
  function findLiveDuplicate(runId:string, requestedId:string, contract:TaskV2, plan:string): Record<string,unknown>|null {
    const row = getTaskRow(db, requestedId, runId);
    if (!row || Date.now() - row.created_at > DISPATCH_IDEMPOTENT_WINDOW_MS) return null;
    if (canonicalJson(JSON.parse(row.contract_json)) !== canonicalJson({ ...contract, id:requestedId })) return null;
    if (sha256(getTaskPlan(db, requestedId) ?? "") !== sha256(plan)) return null;
    const latest = listAttemptsForTask(db, runId, requestedId).at(-1);
    // A task that ended blocked or canceled is dispatched again under a new id, as before. One without an attempt yet is still in preflight.
    if (latest ? ["blocked", "canceled"].includes(latest.state)
      : hasFailedStageReceipt(db, runId, requestedId)) return null;
    return { runId, taskId:requestedId, attemptId:latest?.id ?? null, writerThreadId:latest?.thread_id ?? null, state:latest?.state ?? "queued", deduplicated:true,
      stages:listStageReceipts(db, runId, requestedId),
      note:"This task id with the same contract and plan was already dispatched in the last 30 minutes; this is that task, nothing new was created. Poll lane_pilot_wait_writer or end your turn; Lane Pilot sends you the results." };
  }

  /** The same contract content under a different id (hive-audit H-08): a PM that rephrased only the task id would
   * otherwise start a second writer on identical work. The match needs the same canonical contract (with the stored
   * task's id substituted) and the same plan hash inside the idempotent window; terminal blocked/canceled tasks are
   * dispatched again as new work, as in findLiveDuplicate. */
  function findContentDuplicate(runId:string, requestedId:string, contract:TaskV2, plan:string): Record<string,unknown>|null {
    const rows = listRunTaskRows(db, runId);
    for (const row of rows) {
      if (row.id === requestedId || Date.now() - row.created_at > DISPATCH_IDEMPOTENT_WINDOW_MS) continue;
      if (canonicalJson(JSON.parse(row.contract_json)) !== canonicalJson({ ...contract, id:row.id })) continue;
      if (sha256(getTaskPlan(db, row.id) ?? "") !== sha256(plan)) continue;
      const latest = listAttemptsForTask(db, runId, row.id).at(-1);
      if (latest ? ["blocked", "canceled"].includes(latest.state)
        : hasFailedStageReceipt(db, runId, row.id)) continue;
      return { runId, taskId:row.id, attemptId:latest?.id ?? null, writerThreadId:latest?.thread_id ?? null, state:latest?.state ?? "queued", deduplicated:true,
        stages:listStageReceipts(db, runId, row.id),
        note:`The same contract and plan is already task ${row.id}, dispatched in the last 30 minutes under that id; this is that task, nothing new was created. Poll lane_pilot_wait_writer or end your turn; Lane Pilot sends you the results.` };
    }
    return null;
  }

  /** A member of the task's family («P1», «P1.2») with an open attempt in this project; mainfixes are their own work. */
  async function runningFamilyMember(projectId:string, taskId:string):Promise<{ taskId:string } | null> {
    const family = taskFamily(taskId);
    const same = (other:string) => !isMainfixTask(other) && taskFamily(other) === family;
    const open = listOpenAttempts(db).find((row) => row.project_id === projectId && same(row.task_id));
    if (open) return { taskId:open.task_id };
    // A parked member is a restart ticket, not a writer at work: the PM's own dispatch takes the task over (as a sibling attempt
    // supersedes the ticket in the sweep), so the ticket goes and the dispatch proceeds. Refused, the PM was told to cancel a task
    // that had no open attempt, and a harness park restarts only under a newer build: cab-unslop-kit.3 (2026-10-31) sat between the two.
    const dropped = await services.stability.dropParked((row) => row.projectId === projectId && same(row.taskId) && getRun(db, row.runId)?.closed_at == null);
    if (dropped.length) ctx.log(`Lane Pilot: the dispatch of ${taskId} drops the restart ticket of parked ${dropped.map((row) => row.taskId).join(", ")}`);
    return null;
  }


  /**
   * Where a task works. The run's folder as before; a git repository inside it the PM named as project_cwd; or, in a run
   * folder without git (BB-сервис holds 41 plugin repositories), the repository every path of the task lies in: the task
   * moves into it (paths relative to it) and gets a worktree, a git diff and a merge there instead of the live folder.
   */
  async function placeTask(runId:string, hostId:string, runFolder:string, rawTask:TaskV2, plan:string):Promise<TaskPlacement> {
    // repo_scope is earned here, from the host's answer, never taken from the PM's contract.
    const { repo_scope: _sent, ...task } = rawTask;
    // A section's task that also changes files elsewhere in the same repository (an SDK next to the bots) works at the repository's root.
    const namesRoot = resolve(task.project_cwd) !== resolve(runFolder) && isTaskBase(task.project_cwd, runFolder);
    if (resolve(task.project_cwd) === resolve(runFolder) ? task.owns_paths.some(leavesSection) : namesRoot) {
      const found = await bestEffort(ctx.log, "writer repo root probe", repoReadRoot(host, hostId, runFolder, ["repo:probe"]), null);
      const root = found?.root;
      if (found && root && found.prefix && (!namesRoot || resolve(task.project_cwd) === root)) {
        // The PM that names the root itself already wrote root-relative paths: they stay, and the section is only where the chat is.
        const moved = namesRoot ? { task:{ ...task, repo_scope:true }, outside:task.owns_paths.filter((path) => path !== found.prefix && !path.startsWith(`${found.prefix}/`)) } : rerootToRepoRoot(task, root, found.prefix);
        if (moved) {
          ctx.log(`Lane Pilot: task ${task.id} of the section ${found.prefix} also changes files outside it, so it works at the repository root ${root}`);
          return { task:moved.task, plan:planWithRepoScope(plan, root, found.prefix, moved.outside), repoScope:{ root, section:found.prefix, outside:moved.outside } };
        }
      }
    }
    const repoOf = async (folder:string) => parseRepoTop(await bestEffort(ctx.log, "writer repo top probe", runOnHost(host, { hostId, cwd:runFolder, command:repoTopCommand(folder, runFolder), timeoutSec:20, timeoutMs:25_000 }), null));
    if (resolve(task.project_cwd) !== resolve(runFolder)) {
      const named = relative(resolve(runFolder), resolve(task.project_cwd)).split("\\").join("/");
      if (isTaskBase(runFolder, task.project_cwd) && await repoOf(task.project_cwd) === named) return { task:{ ...task, project_cwd:resolve(task.project_cwd) }, plan };
      return { rejected:`task.project_cwd must equal the configured writerWorkspacePath (${runFolder}) or a git repository inside it` };
    }
    const readRoot = await repoReadRoot(host, hostId, runFolder, [...task.read_first, ...task.never_touch]);
    const fixed = readRoot ? normalizeRepoReads({ ...task, project_cwd:runFolder }, readRoot.prefix) : { ...task, project_cwd:runFolder };
    // The folder of the task's files alone: a check run elsewhere must not hide the repository (drill nogit_repo 2026-10-27).
    const folder = commonTaskFolder({ ...fixed, verification:[] });
    if (!folder || !await services.isLiveFolder(runId, hostId, runFolder)) return { task:fixed, plan };
    const repo = await repoOf(resolve(runFolder, folder));
    const moved = repo ? rerootTask(fixed, repo) : null;
    if (repo && !moved && rerootTask({ ...fixed, verification:[] }, repo)) {
      // Every file is in the repository, so the task cannot work in the folder without git (one writer, no commit, files left untracked in the repository):
      // a check whose cwd lies outside it cannot run in the repository's worktree, and the PM puts it inside.
      return { rejected:`every file of this task is inside the git repository ${repo} of ${runFolder}, so the task works there (its own worktree, merged into its main), but a verification check has its cwd outside it. Set each check's cwd to ${resolve(runFolder, repo)} and write its command with paths relative to that repository (not ${repo}/...)` };
    }
    if (!repo || !moved) return { task:fixed, plan };
    ctx.log(`Lane Pilot: task ${task.id} works in the repository ${repo} of ${runFolder} (its own worktree and merge, not the folder without git)`);
    return { task:moved.task, plan:planWithOutsideReads(plan, moved.outsideReads), movedInto:repo };
  }

  /** `criticCodeDefault`: this task's value of `critic.code.default_for_risk`, over the project's (the bench toggles the code critic per arm with it). */
  return { failDispatch, readWriterWorkspaceFile, findLiveDuplicate, findContentDuplicate, runningFamilyMember, placeTask };
}
