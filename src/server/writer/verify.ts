import { resolve } from "node:path";
import { acceptanceArtifactDir, bbWriterReportMarkdown, buildAcceptanceV2, validateAcceptanceV2 } from "../../acceptance-v2";
import { attemptProduced } from "../../cli-outcome";
import { taskV2Schema } from "../../contracts";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getTaskGitBase, listTasksForRun, loadProjectSettings, saveProjectSetting } from "../../database";
import { sha256 } from "../../stages/contract";
import { parseReadFirstHints } from "../../stages/read-first";
import { buildRunExecutionProfile, buildRunPolicy, mapBounded } from "../../stages/run-policy";
import { classifyWriterOutput, isOutputPath } from "../../validate-output";
import type { VerifyResult } from "../../validate-output";
import { filterOwnershipNoise } from "../../verification/git-ownership";
import { findUnownedChanges, findUnownedRunChanges, resolveRunOwnershipScope } from "../../verification/ownership";
import { recordGateEvaluation } from "../stage-records";
import { stringAt } from "../values";
import { outputText, writerPatchFromOutput } from "../writer-task";
import type { ServerCore } from "../core";
import type { Services } from "../services";

export function createWriterVerify(ctx: ServerCore, services: Services) {
  const { bb, db, host, runPolicyFor } = ctx;

  /**
   * A writer's check runs in a BB terminal of the writer's thread, inside the same sandbox, so the owner can open it
   * and watch; BB reports its output and exit code. Null when terminals are unavailable: the caller falls back.
   */
  async function runInWriterTerminal(input:{config:PrototypeConfig; writerThreadId:string; workspacePath:string; cwd:string; command:string; backend:"auto"|"macos-seatbelt"|"linux-bubblewrap"; timeoutSec:number}) {
    const terminals=(bb.sdk as { terminals?: typeof bb.sdk.terminals }).terminals;
    if (!terminals?.create) return null;
    // Every machine variable of the project (BB's global ones and the project's own) reaches the check; BB puts
    // them into the terminal, and only their names travel here.
    const machineEnv=await Promise.resolve().then(()=>bb.sdk.projects.machineEnvironment({projectId:input.config.projectId})).catch(()=>null);
    const passEnv=(machineEnv?.variables??[]).map((variable)=>variable.name);
    const prepared=await host.call("sandboxCommandLine",{requestedHostId:input.config.hostId,workspacePath:input.workspacePath,cwd:input.cwd,
      command:input.command,backend:input.backend,passEnv},{hostId:input.config.hostId,timeoutMs:30_000});
    if (prepared.hostId!==input.config.hostId) throw new Error("sandbox result host did not match the configured host");
    try {
      let session;
      try {
        session=await terminals.create({cols:160,rows:48,scope:{kind:"thread",threadId:input.writerThreadId},
          start:{mode:"command",command:prepared.commandLine},title:`Lane Pilot check: ${input.command.slice(0,60)}`});
      } catch (cause) {
        bb.log.warn(`verification terminal unavailable, running on the host: ${cause instanceof Error?cause.message:String(cause)}`);
        return null;
      }
      bb.log.info(`verification in terminal ${session.id} of thread ${input.writerThreadId}: ${input.command.slice(0,120)}`);
      const deadline=Date.now()+(input.timeoutSec+15)*1000;
      while (session.status!=="exited"&&session.status!=="disconnected"&&Date.now()<deadline) {
        await new Promise((resolve)=>setTimeout(resolve,1_500));
        session=await terminals.get({terminalId:session.id});
      }
      const read=await terminals.output({terminalId:session.id,tailBytes:200_000}).catch(()=>({chunks:[] as Array<{dataBase64:string}>}));
      const text=read.chunks.map((chunk)=>Buffer.from(chunk.dataBase64,"base64").toString("utf8")).join("");
      if (session.status!=="exited") {
        await terminals.close({terminalId:session.id,mode:"force"}).catch(()=>undefined);
        return {exitCode:124,stdout:text,stderr:session.status==="disconnected"?"verification terminal disconnected":`verification timed out after ${input.timeoutSec}s`,
          backend:prepared.backend,policySha256:prepared.policySha256,workspacePath:prepared.workspacePath,terminalId:session.id};
      }
      bb.log.info(`verification terminal ${session.id} exited ${session.exitCode}`);
      return {exitCode:session.exitCode??1,stdout:text,stderr:"",backend:prepared.backend,policySha256:prepared.policySha256,
        workspacePath:prepared.workspacePath,terminalId:session.id};
    } finally {
      await host.call("sandboxRelease",{requestedHostId:input.config.hostId,...prepared.cleanup},{hostId:input.config.hostId,timeoutMs:30_000}).catch(()=>undefined);
    }
  }

  async function runVerification(config: PrototypeConfig, task: TaskV2, runId?:string, writerThreadId?:string): Promise<Array<VerifyResult & {
    sandboxBackend:string|null; policySha256:string|null; workspacePath:string;
  }>> {
    const policy=runId?runPolicyFor(runId):buildRunPolicy(loadProjectSettings(db,config.projectId));
    const verificationScopes=runId?getRunSettingsScopes(db,runId):[];
    return mapBounded(task.verification,policy.pools.verification,async(command)=>{
      const release=await services.runWriterPool.acquire(`verification:${runId??config.projectId}`,policy.pools.verification);
      try {
      const backend=(loadProjectSettings(db,config.projectId,verificationScopes)["sandbox.backend"] as "auto"|"macos-seatbelt"|"linux-bubblewrap"|undefined) ?? "auto";
      // The sandbox gives a command 120 s when the task names no limit; waiting only 30 s cut longer checks short.
      const timeoutSec=command.timeout_sec ?? 120;
      const inTerminal=writerThreadId ? await runInWriterTerminal({config,writerThreadId,workspacePath:task.project_cwd,cwd:command.cwd,
        command:command.command,backend,timeoutSec}).catch((cause:unknown)=>{
          bb.log.warn(`verification terminal failed, running on the host: ${cause instanceof Error?cause.message:String(cause)}`);
          return null;
        }) : null;
      if (inTerminal) return {command:command.command,exitCode:inTerminal.exitCode,stdout:inTerminal.stdout,stderr:inTerminal.stderr,
        sandboxBackend:inTerminal.backend,policySha256:inTerminal.policySha256,workspacePath:inTerminal.workspacePath};
      const ran = await host.call("runSandboxedCommand", {
        requestedHostId: config.hostId,
        workspacePath:task.project_cwd,
        backend,
        command:command.command,
        cwd: command.cwd,
        timeoutSec,
      }, { hostId:config.hostId, timeoutMs:(timeoutSec + 15) * 1000 }).catch((cause: unknown) => ({
        hostId: config.hostId,
        exitCode: 1,
        stdout: "",
        stderr: cause instanceof Error ? cause.message : String(cause),
        backend:null as "macos-seatbelt"|"linux-bubblewrap"|null,
        policySha256:null as string|null,
        workspacePath:task.project_cwd,
      }));
      if (ran.hostId !== config.hostId) {
        return {command:command.command,exitCode:1,stdout:"",stderr:"sandbox result host did not match the configured host",
          sandboxBackend:null,policySha256:null,workspacePath:task.project_cwd};
      }
      return {command:command.command,exitCode:ran.exitCode,stdout:typeof ran.stdout==="string"?ran.stdout:"",stderr:typeof ran.stderr==="string"?ran.stderr:"",
        sandboxBackend:ran.backend,policySha256:ran.policySha256,workspacePath:ran.workspacePath};
      } finally { release(); }
    });
  }

  async function persistWriterAcceptance(input: {
    config:PrototypeConfig; task:TaskV2; runId:string; taskId:string; attempt:number;
    attemptId:string; pmThreadId:string; writerThreadId:string; output:string; verification:VerifyResult[];
    emergencyFallback?:{reason:string;primaryAttemptId:string;providerId:string;model:string};
    review?:"passed"|"not_required";
  }): Promise<Record<string,unknown>> {
    const reportText = bbWriterReportMarkdown(input.task, input.attempt);
    const reasoningTrace = getReasoningTrace(db, input.attemptId);
    const acceptance = buildAcceptanceV2({
      task:input.task, attempt:input.attempt,
      providerId:reasoningTrace?.providerId ?? input.config.writerProviderId,
      model:reasoningTrace?.model ?? input.config.writerModel, reportText,
      review:input.review,
    });
    const validation = validateAcceptanceV2(acceptance);
    if (!validation.ok) throw new Error(`upstream acceptance-v2 rejected generated receipt: ${validation.errors.join("; ")}`);
    const artifactDir = acceptanceArtifactDir(input.task.project_cwd, input.runId, input.taskId);
    const internalReceipt = {
      schemaVersion:1, status:"accepted", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
      attemptId:input.attemptId, pmThreadId:input.pmThreadId, writerThreadId:input.writerThreadId,
      ownsPaths:input.task.owns_paths, readFirst:parseReadFirstHints(input.task.read_first),
      output:input.output, verification:input.verification,
      runV2:buildRunExecutionProfile(input.task.risk,runPolicyFor(input.runId)),
      reasoning:reasoningTrace ? [reasoningTrace] : [],
      emergencyFallback:input.emergencyFallback ?? null,
    };
    for (const [name, content] of [
      ["report.md", reportText],
      ["acceptance.json", `${JSON.stringify(acceptance, null, 2)}\n`],
      ["lane-pilot-receipt.json", `${JSON.stringify(internalReceipt, null, 2)}\n`],
    ] as const) {
      await bb.sdk.files.write({
        hostId:input.config.hostId, rootPath:input.task.project_cwd,
        path:`${artifactDir}/${name}`, content, contentEncoding:"utf8", createParents:true, expectedSha256:null,
      });
    }
    const stored = {
      ...internalReceipt,
      acceptancePath: `${artifactDir}/acceptance.json`,
      acceptance,
    };
    saveProjectSetting(db, input.config.projectId, "writer.lastResult", stored);
    const patch = writerPatchFromOutput(input.output);
    if (patch) saveProjectSetting(db, input.config.projectId, "writer.lastPatch", patch);
    return stored;
  }

  async function validateWriterResult(input: {
    config:PrototypeConfig; projectId:string; runId:string; taskId:string; attempt:number; task:TaskV2; writerThreadId:string; attemptId:string; dirtBefore:import("../../cli-outcome").DirtSnapshot[];
  }): Promise<{ status:"accepted"|"empty_output"|"validation_failed"; reason?:string; output:string; produced:string[]; verification:VerifyResult[];runV2?:ReturnType<typeof buildRunExecutionProfile> }> {
    const output = await bb.sdk.threads.output({ threadId:input.writerThreadId });
    const dirt = await services.workspaceDirt(input.config, input.task.project_cwd);
    if (!dirt.ok) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"failed",input:JSON.stringify(input.task),summary:{reason:"workspace_snapshot_unavailable"}});
      return { status:"validation_failed", reason:dirt.reason, output:outputText(output), produced:[], verification:[] };
    }
    const unverifiable = input.dirtBefore
      .filter((before) => !before.sha256 && dirt.snapshots.some((after) => after.path === before.path))
      .map((file) => file.path);
    if (unverifiable.length > 0) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"failed",input:JSON.stringify(input.task),summary:{unverifiableCount:unverifiable.length}});
      return {
        status:"validation_failed",
        reason:`cannot compare pre-existing dirty file content: ${unverifiable.join(", ")}`,
        output:outputText(output), produced:[], verification:[],
      };
    }
    let produced = attemptProduced(dirt.snapshots, input.dirtBefore);
    const runTasks = listTasksForRun(db,input.runId);
    const runOwnershipTasks = runTasks.flatMap((row) => {
      if (row.kind !== "bb") return [];
      const parsed = taskV2Schema.safeParse(row.contract);
      return parsed.success && parsed.data.id === row.id ? [{ ...parsed.data }] : [];
    });
    const persistedRun = getRun(db,input.runId);
    const persistedAttempt = getAttempt(db,input.attemptId);
    // In the attempt's own worktree, work may already sit in a commit: the writer committed it, or Lane Pilot
    // committed it on the way to main and was cut off mid-merge (a host restart) before this re-check. Those
    // files count too; otherwise a finished task reads as «writer changed no files» and never reaches main.
    const basePath = persistedRun?.writer_workspace_path;
    if (basePath && resolve(basePath) !== resolve(input.task.project_cwd)) {
      const base = await host.call("gitOwnershipBase",{requestedHostId:input.config.hostId,projectCwd:basePath},
        {hostId:input.config.hostId,timeoutMs:30_000}).catch(()=>null);
      const committed = base?.status==="ready" && base.headSha ? await host.call("gitOwnershipChanges",{
        requestedHostId:input.config.hostId,projectCwd:input.task.project_cwd,baseSha:base.headSha,compareCommitted:true,
      },{hostId:input.config.hostId,timeoutMs:30_000}).catch(()=>null) : null;
      if (committed?.status==="ready" && committed.paths.length) produced = [...new Set([...produced,...committed.paths])].sort();
    }
    // Task-v2 contracts stay bound to the run's configured project workspace. A
    // risk-routed attempt may execute in its own managed worktree, so validate that
    // separate CAS binding instead of requiring the task contract cwd to equal it.
    const contractWorkspace = persistedRun?.writer_workspace_path ?? runOwnershipTasks[0]?.project_cwd;
    const attemptWorkspaceMatches = persistedAttempt?.run_id === input.runId
      && persistedAttempt.task_id === input.taskId
      && persistedAttempt.workspace_path === input.task.project_cwd;
    const ownershipScope = runTasks.length === runOwnershipTasks.length && contractWorkspace && attemptWorkspaceMatches
      ? resolveRunOwnershipScope(runOwnershipTasks,input.taskId,contractWorkspace)
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
        baseSha:gitBase.compare_committed?gitBase.base_sha:null,compareCommitted:gitBase.compare_committed,
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
    const noiseFree=new Set(filterOwnershipNoise(produced));
    const attributed=produced.filter((path)=>noiseFree.has(path)||findUnownedChanges([path],input.task).length===0);
    const checkedPaths=[...new Set([...attributed,...branchChanges])].sort();
    const unowned = findUnownedRunChanges(checkedPaths, ownershipScope.tasks);
    if (unowned.length) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"rejected",input:JSON.stringify(input.task),summary:{unownedCount:unowned.length}});
      recordGateEvaluation(db,{...input,gate:"validate",status:"skipped",input:JSON.stringify(input.task),summary:{reason:"ownership_rejected"}});
      return { status:"validation_failed", reason:`writer changed paths outside owns_paths or inside never_touch: ${unowned.join(", ")}`,
        output:outputText(output), produced:checkedPaths, verification:[] };
    }
    recordGateEvaluation(db,{...input,gate:"owns-paths",status:"passed",input:JSON.stringify(input.task),summary:{changedPathCount:checkedPaths.length,branchChangedPathCount:branchChanges.length,scope:"run",taskCount:ownershipScope.taskIds.length,gitBase:gitBase?{ref:gitBase.base_ref,sha:gitBase.base_sha,branch:gitBase.branch,compareCommitted:!!gitBase.compare_committed,pathsSha256:sha256(branchChanges.join("\0"))}:null}});
    const contents: Record<string, string | null> = {};
    for (const rel of new Set([...input.task.expected_outputs.filter(isOutputPath), ...produced])) {
      const absolute = rel.startsWith("/") ? rel : `${input.task.project_cwd}/${rel}`;
      const read = await bb.sdk.files.read({
        hostId:input.config.hostId,
        rootPath:input.task.project_cwd,
        path:absolute,
      }).catch(() => null);
      contents[rel] = read ? stringAt(read, "content") : null;
    }
    const verifies = await runVerification(input.config, input.task, input.runId, input.writerThreadId);
    recordGateEvaluation(db,{...input,gate:"verification",status:verifies.length===0?"skipped":verifies.every((row)=>row.exitCode===0)?"passed":"failed",
      input:JSON.stringify(input.task),summary:{commandCount:verifies.length,failedCount:verifies.filter((row)=>row.exitCode!==0).length}});
    const classified = classifyWriterOutput({ task:input.task, produced, contents, verifies });
    if (input.task.expected_outputs.includes("hello.txt") && input.task.expected_outputs.includes("tests/hello.test.txt")) {
      const helloOk = contents["hello.txt"] === "hello from native BB writer\n";
      const testOk = contents["tests/hello.test.txt"] === "hello from native BB writer\n";
      if (!helloOk || !testOk) {
        recordGateEvaluation(db,{...input,gate:"validate",status:"rejected",input:JSON.stringify(input.task),summary:{reason:"fixture_output_mismatch"}});
        return {
          status: contents["hello.txt"] == null && contents["tests/hello.test.txt"] == null ? "empty_output" : "validation_failed",
          reason:"fixture output content mismatch",
          output:outputText(output),
          produced:checkedPaths, verification:verifies,
        };
      }
    }
    if (!classified.ok) {
      recordGateEvaluation(db,{...input,gate:"validate",status:"rejected",input:JSON.stringify(input.task),summary:{reason:"writer_output_not_accepted"}});
      return { status:classified.state, reason:classified.reason, output:outputText(output), produced:checkedPaths, verification:verifies };
    }
    recordGateEvaluation(db,{...input,gate:"validate",status:"passed",input:JSON.stringify(input.task),summary:{producedCount:checkedPaths.length}});
    return { status:"accepted", output:outputText(output), produced:checkedPaths, verification:verifies,
      runV2:buildRunExecutionProfile(input.task.risk,runPolicyFor(input.runId)) };
  }

  return { runVerification, persistWriterAcceptance, validateWriterResult };
}
