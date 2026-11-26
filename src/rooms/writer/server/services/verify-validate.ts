import { familyDirtBaseline } from "../../models/verify";
import type { openDatabase } from "../../../storage";
import { bookkeepingSetting, filterOwnershipNoise } from "@lane-pilot/settings-catalog";
import { runOnHost } from "@lane-pilot/host-calls";
import { isAbsolute, relative, resolve } from "node:path";
import { buildRunExecutionProfile, classifyWriterOutput, isOutputFolder, isOutputPath, trustedToolingHint } from "../../../tasks";
import { sha256 } from "../../../tasks/server";
import { attemptProduced } from "../../models/cli-outcome";
import { taskV2Schema } from "../../../contracts";
import type { PrototypeConfig, TaskV2 } from "../../../contracts";
import { getAttempt, getRunSettingsScopes, getTaskGitBase, listTasksForRun, loadProjectSettings, taskBasePath, otherAttemptsOfRun, attemptedTaskIdsOfRun } from "../../../storage";
import { cleanCheckOutput, outputText } from "@lane-pilot/kit";
import { writeReplacing } from "../../../storage";
import { bestEffort, fileAllowedByOwns, fileBlockedByNeverTouch, isNotFound, orMiss, stringAt } from "@lane-pilot/kit";
import { SecretsNotReadyError } from "../../../secrets/server";
import type { VerifyResult } from "../../../tasks";
import { isLiveDecision } from "../../models/live-folder";
import { taskFamily } from "@lane-pilot/contracts";
import { detectFalseDone } from "../../../verification";
import { beginVerdictReceipt, finishVerdictReceipt } from "../../../verification/server";
import { dropSatellites, findUnownedChanges, findUnownedRunChanges, resolveRunOwnershipScope } from "../../../contracts/ownership";
import { recordGateEvaluation } from "../../../runs/server";
import { hasTaskHome } from "../../../storage";
import { recordCheckFiles } from "./task-home";
import type { ServerCore } from "../../../contracts/server";
import type { FailureCode } from "../../../contracts/failure-class";
import { createVerifyAcceptance } from "./verify-acceptance";
import type { Services as VerifyServices } from "./verify";
/** The fields of the services bag this file reads, typed by the rooms that own them. */
/** A sandbox that refused the runner its own files: macOS python3 shim «couldn't create cache file … Operation not permitted». */

/**
 * A verification command that fails is run once more: a check that fails once and passes on a re-run (a cold cache, a
 * port still held by the previous run) is flaky, not the writer's fault. Exit 124 is a timeout (the terminal and the
 * host sandbox both report it so) and is not repeated: it would only double the wait.
 * The pass used to replace the failure, and «load» was a guess nobody measured. Now the result keeps the first failure
 * (exit code, output tail) and a machine reading taken just before each attempt (`sample`, on the host the check runs
 * on), with a verdict that names its basis: `machine_pressure` only when a reading crossed a limit, else `unexplained`.
 * A failure that failed its re-run too says `reran` and keeps that re-run (`rerun`): the post-merge check reads both and runs it no third
 * time only when both are product reds (a re-run that timed out reproduced nothing; SMA audit N-05).
 */
export type ValidateDeps = { ctx: ServerCore; db: ReturnType<typeof openDatabase>; services: VerifyServices; runVerification: (config: PrototypeConfig, task: TaskV2, runId?: string, writerThreadId?: string, options?: { background?: boolean; jobKey?: string; isolated?: boolean; cwd?: string; throwaway?: boolean; record?: boolean; attempt?: number; revision?: import("../../models/verify").CheckRevision }) => Promise<VerifyResult[]>; writerTrace: ReturnType<typeof createVerifyAcceptance>["writerTrace"]; persistWriterAcceptance: ReturnType<typeof createVerifyAcceptance>["persistWriterAcceptance"] };

export function createVerifyValidate({ ctx, db, services, runVerification, writerTrace, persistWriterAcceptance }: ValidateDeps) {
  const { bb, host, runPolicyFor } = ctx;
  async function validateWriterResult(input: {
    config:PrototypeConfig; projectId:string; runId:string; taskId:string; attempt:number; task:TaskV2; writerThreadId:string; attemptId:string; dirtBefore:import("../../models/cli-outcome").DirtSnapshot[];
  }): Promise<{ status:"accepted"|"empty_output"|"validation_failed"; reason?:string; output:string; produced:string[]; verification:VerifyResult[]; checkLogPath?:string; runV2?:ReturnType<typeof buildRunExecutionProfile>;
    /** Receipt warnings of an accepted result (a shape-only gate that did not reject). */
    warnings?:string[];
    /** Hash of the content of the files the attempt changed: two turns with the same one left the diff as it was. */
    diffKey?:string;
    /** The structured facts of a red check, when the failure is one (classifyWriterOutput). */
    failureCode?:FailureCode; checkName?:string; timeoutSec?:number }> {
    const output = await bb.sdk.threads.output({ threadId:input.writerThreadId });
    const bookkeeping = bookkeepingSetting(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)));
    const dirt = await services.workspaceDirt(input.config, input.task.project_cwd, input.runId);
    if (!dirt.ok) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"failed",input:JSON.stringify(input.task),summary:{reason:"workspace_snapshot_unavailable"}});
      return { status:"validation_failed", reason:dirt.reason, output:outputText(output), produced:[], verification:[] };
    }
    // In in_place mode an earlier attempt of the same task family leaves its edits in the shared checkout. Only the
    // files those attempts produced count as this family's produced work; dirt from other tasks or the owner keeps
    // its baseline, so it is never counted as produced.
    const familyProduced = new Set<string>();
    // A folder without git rolls a failed attempt back, so no leftover of an earlier attempt exists to count; a file
    // that sat in the folder before this attempt is no output of it either, however the contract names it.
    const liveFolder = isLiveDecision(getAttempt(db, input.attemptId)?.workspace_decision);
    if (!liveFolder) for (const row of otherAttemptsOfRun(db, input.runId, input.attemptId)) {
      if (taskFamily(row.task_id) !== taskFamily(input.taskId)) continue;
      const saved = await bestEffort(bb.log, "verification produced files read", bb.storage.kv.get(`writer-produced:${row.id}`), null);
      if (Array.isArray(saved)) for (const path of saved) if (typeof path === "string") familyProduced.add(path);
    }
    const comparable = familyDirtBaseline(input.task, input.dirtBefore, familyProduced);
    // Bookkeeping (BB chat files, Lane Pilot's own records) never counts as a change, so its missing hash blocks nothing.
    const unverifiable = filterOwnershipNoise(comparable
      .filter((before) => !before.sha256 && dirt.snapshots.some((after) => after.path === before.path))
      .map((file) => file.path), bookkeeping);
    if (unverifiable.length > 0) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"failed",input:JSON.stringify(input.task),summary:{unverifiableCount:unverifiable.length}});
      return {
        status:"validation_failed",
        reason:`cannot compare pre-existing dirty file content: ${unverifiable.join(", ")}`,
        output:outputText(output), produced:[], verification:[],
      };
    }
    let produced = attemptProduced(dirt.snapshots, comparable);
    // A folder without git is shared with the PM and the owner: a file outside owns_paths that changed meanwhile is the
    // writer's only when its own thread touched it (a file edit or a command naming it). The drill's PM edited the
    // folder during a writer's attempt and the writer was blamed for it (live sandbox 2026-10-07, 0.1.178).
    if (liveFolder) {
      const trace = await writerTrace(input.writerThreadId);
      // A file another task of the run owns was made by that task's writer, in this folder while this attempt waited for
      // it; a file name alone in this writer's thread («README.md», «settings.ts») does not make it this writer's. Only
      // its full path does (BB-сервис 2026-10-10: lane-stack was blamed for the agency, content-factory and computer-use files).
      // A sibling moved into a repository inside this folder owns its paths from there: they are read from this folder.
      const ownBase = taskBasePath(db, input.runId, input.taskId) ?? input.task.project_cwd;
      const siblingOwns = listTasksForRun(db, input.runId).flatMap((row) => {
        if (row.id === input.taskId) return [];
        const parsed = taskV2Schema.safeParse(row.contract);
        if (!parsed.success) return [];
        const inside = relative(resolve(ownBase), resolve(parsed.data.project_cwd)).split("\\").join("/");
        if (inside.startsWith("..") || isAbsolute(inside)) return [];
        return [inside ? parsed.data.owns_paths.map((pattern) => `${inside}/${pattern}`) : parsed.data.owns_paths];
      });
      const foreign = produced.filter((path) => !fileAllowedByOwns(path, input.task.owns_paths) && (siblingOwns.some((owns) => fileAllowedByOwns(path, owns))
        ? !trace?.includes(path)
        : trace !== null && !trace.includes(path) && !trace.includes(path.split("/").pop() ?? path)));
      if (foreign.length) {
        ctx.log(`Lane Pilot: ${foreign.join(", ")} changed in the live folder during ${input.taskId}, not by its writer; left out of its check`);
        produced = produced.filter((path) => !foreign.includes(path));
      }
    }
    const diffKey = sha256(produced.map((path) => `${path}:${dirt.snapshots.find((row) => row.path === path)?.sha256 ?? ""}`).join("\n"));
    // The files this attempt's changes produced, for the next attempt of the task family: only these may later
    // leave a redispatch's dirt baseline.
    void bestEffort(bb.log, "verification produced files record", bb.storage.kv.set(`writer-produced:${input.attemptId}`, produced as never), undefined);
    // A task rejected before it ever ran (preflight, plan critique) claims no files; its contract may even be unsafe
    // («../other-repo/» in owns_paths), and kept in the scope it failed every later task of the run (BB-сервис 2026-10-05).
    const attempted = new Set(attemptedTaskIdsOfRun(db, input.runId));
    const runTasks = listTasksForRun(db,input.runId).filter((row) => row.id === input.taskId || attempted.has(row.id));
    const runOwnershipTasks = runTasks.flatMap((row) => {
      if (row.kind !== "bb") return [];
      const parsed = taskV2Schema.safeParse(row.contract);
      return parsed.success && parsed.data.id === row.id ? [{ ...parsed.data }] : [];
    });
    const persistedAttempt = getAttempt(db,input.attemptId);
    // In the attempt's own worktree, work may already sit in a commit: the writer committed it, or Lane Pilot
    // committed it on the way to main and was cut off mid-merge (a host restart) before this re-check. Those
    // files count too; otherwise a finished task reads as «writer changed no files» and never reaches main.
    // The task's own checkout: the run's folder, or the repository inside it the task works in.
    const basePath = taskBasePath(db, input.runId, input.taskId);
    if (basePath && resolve(basePath) !== resolve(input.task.project_cwd)) {
      const base = await bestEffort(ctx.log, "verification ownership base", host.call("gitOwnershipBase",{requestedHostId:input.config.hostId,projectCwd:basePath},
        {hostId:input.config.hostId,timeoutMs:30_000}), null);
      const committed = base?.status==="ready" && base.headSha ? await bestEffort(ctx.log, "verification ownership changes", host.call("gitOwnershipChanges",{
        requestedHostId:input.config.hostId,projectCwd:input.task.project_cwd,baseSha:base.headSha,compareCommitted:true,bookkeeping,
      },{hostId:input.config.hostId,timeoutMs:30_000}), null) : null;
      if (committed?.status==="ready" && committed.paths.length) produced = [...new Set([...produced,...committed.paths])].sort();
    }
    // Task-v2 contracts stay bound to the run's configured project workspace. A
    // risk-routed attempt may execute in its own managed worktree, so validate that
    // separate CAS binding instead of requiring the task contract cwd to equal it.
    const contractWorkspace = basePath ?? runOwnershipTasks[0]?.project_cwd;
    const attemptWorkspaceMatches = persistedAttempt?.run_id === input.runId
      && persistedAttempt.task_id === input.taskId
      && persistedAttempt.workspace_path === input.task.project_cwd;
    const ownershipScope = runTasks.length === runOwnershipTasks.length && contractWorkspace && attemptWorkspaceMatches
      // Tasks of another checkout (another repository of the same folder) are not in this one's scope.
      ? resolveRunOwnershipScope(runOwnershipTasks.filter((task) => task.project_cwd === contractWorkspace),input.taskId,contractWorkspace)
      : { ok:false as const, reason:"run scope contains a non-BB or invalid task contract" };
    if (!ownershipScope.ok) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"failed",input:JSON.stringify(input.task),summary:{reason:"run_scope_invalid"}});
      recordGateEvaluation(db,{...input,gate:"validate",status:"skipped",input:JSON.stringify(input.task),summary:{reason:"run_scope_invalid"}});
      return { status:"validation_failed", reason:`ownership run scope invalid: ${ownershipScope.reason}`,
        output:outputText(output), produced, verification:[] };
    }
    const gitBase=getTaskGitBase(db,input.taskId);
    let branchChanges:string[]=[];
    if(gitBase) {
      const gitResult=await host.call("gitOwnershipChanges",{
        requestedHostId:input.config.hostId,projectCwd:input.task.project_cwd,
        baseSha:gitBase.compare_committed?gitBase.base_sha:null,compareCommitted:gitBase.compare_committed,bookkeeping,
      },{hostId:input.config.hostId,timeoutMs:30_000});
      if(gitResult.status!=="ready") {
        recordGateEvaluation(db,{...input,gate:"owns-paths",status:"failed",input:JSON.stringify(input.task),summary:{reason:"git_branch_diff_unavailable",detail:gitResult.reason}});
        recordGateEvaluation(db,{...input,gate:"validate",status:"skipped",input:JSON.stringify(input.task),summary:{reason:"git_branch_diff_unavailable"}});
        return {status:"validation_failed",reason:`ownership git base could not be evaluated: ${gitResult.reason??gitResult.status}`,output:outputText(output),produced,verification:[]};
      }
      branchChanges=gitResult.paths;
    }
    // The working tree of a shared checkout also holds what hooks and sibling agents wrote meanwhile
    // (.agents/memory episodes, PROGRESS.md, design probes); only paths this task owns stay attributed to it.
    const noiseFree=new Set(filterOwnershipNoise(produced, bookkeeping));
    const attributed=produced.filter((path)=>noiseFree.has(path)||findUnownedChanges([path],input.task).length===0);
    const checkedPaths=[...new Set([...attributed,...branchChanges])].sort();
    // A path no task of the run owns fails here; name this task's other stray files (a sibling's) with it, or the
    // retry fixes only the named one and the per-task check below spends the last attempt on the rest.
    const runUnowned = findUnownedRunChanges(checkedPaths, ownershipScope.tasks);
    const flagged = runUnowned.length ? [...new Set([...runUnowned,...findUnownedChanges(checkedPaths,input.task)])].sort() : [];
    // Satellites (F-02): a test or a locale file that belongs to an owned change of this same attempt is
    // legitimate — 42 % of a month's rejections were such repeating pairs; the rest still rejects the attempt.
    const anchors = checkedPaths.filter((path) => !flagged.includes(path));
    const dropped = dropSatellites(flagged, anchors, input.task.never_touch);
    const unowned = dropped.unowned;
    if (dropped.satellites.length) ctx.log?.(`Lane Pilot: ${dropped.satellites.join(", ")} sit next to owned changes of ${input.taskId} (test/locale satellites); not violations`);
    if (unowned.length) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"rejected",input:JSON.stringify(input.task),summary:{unownedCount:unowned.length,satelliteCount:dropped.satellites.length}});
      recordGateEvaluation(db,{...input,gate:"validate",status:"skipped",input:JSON.stringify(input.task),summary:{reason:"ownership_rejected"}});
      const trusted = trustedToolingHint(unowned, input.task);
      return { status:"validation_failed", reason:`writer changed paths outside owns_paths or inside never_touch: ${unowned.join(", ")}${trusted ? `; ${trusted}` : ""}; there is no write right to a file outside the contract — undo your edits there; if the task needs those files, ask the PM for them and list them`,
        output:outputText(output), produced:checkedPaths, verification:[], diffKey };
    }
    recordGateEvaluation(db,{...input,gate:"owns-paths",status:"passed",input:JSON.stringify(input.task),summary:{changedPathCount:checkedPaths.length,branchChangedPathCount:branchChanges.length,satelliteCount:dropped.satellites.length||undefined,scope:"run",taskCount:ownershipScope.taskIds.length,gitBase:gitBase?{ref:gitBase.base_ref,sha:gitBase.base_sha,branch:gitBase.branch,compareCommitted:!!gitBase.compare_committed,pathsSha256:sha256(branchChanges.join("\0"))}:null}});
    const contents: Record<string, string | null | undefined> = {};
    for (const rel of new Set([...input.task.expected_outputs.filter(isOutputPath), ...produced])) {
      const absolute = rel.startsWith("/") ? rel : `${input.task.project_cwd}/${rel}`;
      let content: string | null | undefined;
      // A folder («…/scripts-snapshot/», «…/out/**») is not a file to read: it is there when a file is under it. Read as a file it came
      // back «unreadable» and a finished writer was blocked on it three times (aura-lab w3d13f9ae-T1, 2026-11-10).
      if (isOutputFolder(rel)) {
        const dir = absolute.replace(/\/\*\*$/, "");
        const probe = await bestEffort(ctx.log, "verification folder probe", runOnHost(host, { hostId:input.config.hostId, cwd:input.task.project_cwd, command:`find '${dir.replace(/'/g, `'\\''`)}' -type f -print -quit`, timeoutSec:15 }), null);
        contents[rel] = !probe ? undefined : probe.exitCode === 0 && probe.stdout.trim() ? "" : null;
        continue;
      }
      try {
        const read = await orMiss(bb.sdk.files.read({
          hostId:input.config.hostId,
          rootPath:input.task.project_cwd,
          path:absolute,
        }), null, isNotFound);
        content = read ? stringAt(read, "content") : null;
      } catch (cause) {
        // One unreadable file is left unknown, named; the rest of the verification still runs. undefined is the
        // read-outage outcome, distinct from null (absent) — the classifier holds the task on it.
        ctx.log(`verification ${input.taskId}: the file ${rel} could not be read (${cause instanceof Error ? cause.message : String(cause)}); its content is left unknown`);
        content = undefined;
      }
      contents[rel] = content;
    }
    const homed = hasTaskHome(db, input.taskId);
    const { preliminary } = await beginVerdictReceipt(ctx, {
      hostId: input.config.hostId, projectCwd: input.task.project_cwd, basePath,
      runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, homed, task: input.task,
    });
    let verifies:Awaited<ReturnType<typeof runVerification>>;
    // When this attempt runs in its own managed worktree the checks run on a throwaway copy of the candidate
    // (SMA m_ck_isolated): a changed protected root fails them, and the receipt's copy measure names the copy.
    try { verifies = await runVerification(input.config, input.task, input.runId, input.writerThreadId, { throwaway: attemptWorkspaceMatches }); }
    catch (cause) {
      // A secret the checks need went away or was taken off the allow list: the task waits for it, no attempt is spent.
      if (!(cause instanceof SecretsNotReadyError)) throw cause;
      recordGateEvaluation(db,{...input,gate:"verification",status:"skipped",input:JSON.stringify(input.task),summary:{reason:cause.message}});
      return { status:"validation_failed", reason:cause.message, output:outputText(output), produced:checkedPaths, verification:[], diffKey };
    }
    const finalReceipt = await finishVerdictReceipt(ctx, {
      preliminary, hostId: input.config.hostId, projectCwd: input.task.project_cwd, basePath,
      runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, homed, verifies,
    });
    recordGateEvaluation(db,{...input,gate:"verification",status:verifies.length===0?"skipped":verifies.every((row)=>row.exitCode===0)?"passed":"failed",
      input:JSON.stringify(input.task),summary:{commandCount:verifies.length,failedCount:verifies.filter((row)=>row.exitCode!==0).length,receiptHash:finalReceipt.receiptHash,verdict:finalReceipt.verdict}});
    // What the checks themselves wrote outside owns_paths is no one's work: `next build` rewrites next-env.d.ts, a
    // screenshot run regenerates every page's PNG. Left in the attempt's worktree, the same-thread retry counted it as
    // the writer's («owns_paths rejected …/next-env.d.ts», cakekeeper ck-26.2 and ck-31, 2026-10-12) and an accepted
    // attempt's `git add -A` merged it into main. Only in the attempt's own worktree, and only files that were clean
    // before the checks, so HEAD is exactly their state before them; a shared checkout may hold others' work.
    if (verifies.length && basePath && resolve(basePath) !== resolve(input.task.project_cwd) && !liveFolder) {
      const undone = await bestEffort(ctx.log, "verification undo check writes", host.call("gitUndoCheckWrites", { requestedHostId:input.config.hostId, projectCwd:input.task.project_cwd,
        keep:dirt.snapshots.map((row) => row.path), ownsPaths:input.task.owns_paths, neverTouch:input.task.never_touch, bookkeeping },
      { hostId:input.config.hostId, timeoutMs:120_000 }), null);
      if (undone && (undone.reverted.length || undone.failed.length)) {
        ctx.log(`Lane Pilot: the checks of ${input.taskId} wrote outside owns_paths; put back ${undone.reverted.join(", ") || "nothing"}${undone.failed.length ? `, could not: ${undone.failed.join(", ")}` : ""}`);
      }
    }
    // A failing check's full output goes under the task folder logs/, so the retry reads it instead of rerunning blind.
    const failedVerify = verifies.find((row) => row.exitCode !== 0);
    let checkLogPath:string|undefined;
    // A task with a home (docs/task-folder.md): checks.json and the failed check's log in the attempt's folder there, in the base checkout,
    // so the next attempt finds the log by the manifest (kind check-log) after this worktree is gone.
    if (hasTaskHome(db, input.taskId)) {
      if (verifies.length) {
        const recorded = await recordCheckFiles({ bb, db }, { taskId:input.taskId, runId:input.runId, attemptId:input.attemptId, verifies, cleanOutput:cleanCheckOutput })
          .catch((cause:unknown) => { ctx.log(`Lane Pilot: the checks of ${input.taskId} were not recorded in its home: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
        checkLogPath = recorded?.checkLog ?? undefined;
      }
    } else if (failedVerify) {
      const slug = failedVerify.command.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "check";
      checkLogPath = `.agents/plans/items/${input.taskId}/logs/${slug}.log`;
      const saved = await bestEffort(ctx.log, "verification check log write", writeReplacing(bb.sdk.files, { hostId:input.config.hostId, rootPath:input.task.project_cwd, path:`${input.task.project_cwd}/${checkLogPath}`,
        content:`$ ${failedVerify.command}\nexit ${failedVerify.exitCode}\n\n${cleanCheckOutput(failedVerify.stdout)}\n${cleanCheckOutput(failedVerify.stderr)}`.trim() + "\n",
        createParents:true }), null);
      if (!saved) checkLogPath = undefined;
    }
    // Same attribution as the run-scope gate: Lane Pilot's own receipt from a pass a reload cut off (.agents/runs/…)
    // is no writer change, and read as one it failed finished SelfyStudio tasks on resume (2026-10-04).
    const answerText = outputText(output);
    // Owned files that already carried content at the attempt's start: the contract may name them as outputs the
    // attempt inherited (a sibling attempt's edits), so they are met, not missing, once real work was produced.
    const preexisting = liveFolder ? [] : input.dirtBefore
      .filter((row) => row.sha256 && fileAllowedByOwns(row.path, input.task.owns_paths) && !fileBlockedByNeverTouch(row.path, input.task.never_touch))
      .map((row) => row.path);
    const classified = classifyWriterOutput({ task:input.task, produced:attributed, contents, verifies,
      answered:answerText.trim().length > 0, preexisting });
    if (!classified.ok) {
      recordGateEvaluation(db,{...input,gate:"validate",status:"rejected",input:JSON.stringify(input.task),summary:{reason:"writer_output_not_accepted"}});
      return { status:classified.state, reason:classified.reason, output:answerText, produced:checkedPaths, verification:verifies, diffKey,
        ...(classified.failureCode ? { failureCode:classified.failureCode } : {}),
        ...(classified.checkName ? { checkName:classified.checkName } : {}),
        ...(classified.timeoutSec !== undefined ? { timeoutSec:classified.timeoutSec } : {}),
        ...(checkLogPath ? { checkLogPath } : {}) };
    }
    const falseDone = detectFalseDone({ writerOutput: answerText, diffPaths: checkedPaths, receipt: finalReceipt });
    if (falseDone.verdict === "fail") {
      recordGateEvaluation(db,{...input,gate:"validate",status:"rejected",input:JSON.stringify(input.task),summary:{reason:falseDone.reason}});
      return { status:"validation_failed", reason:falseDone.reason!, output:answerText, produced:checkedPaths, verification:verifies, diffKey };
    }
    recordGateEvaluation(db,{...input,gate:"validate",status:"passed",input:JSON.stringify(input.task),summary:{producedCount:checkedPaths.length,...(classified.warnings?.length?{warnings:classified.warnings}:{})}});
    return { status:"accepted", output:outputText(output), produced:checkedPaths, verification:verifies, diffKey,
      ...(classified.warnings?.length ? { warnings:classified.warnings } : {}),
      runV2:buildRunExecutionProfile(input.task.risk,runPolicyFor(input.runId)) };
  }

  return { validateWriterResult };
}
