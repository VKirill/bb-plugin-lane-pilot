import { resolve } from "node:path";
import { acceptanceArtifactDir, bbWriterReportMarkdown, buildAcceptanceV2, validateAcceptanceV2 } from "../../acceptance-v2";
import { attemptProduced } from "../../cli-outcome";
import { taskV2Schema } from "../../contracts";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { recordCheckDuration, recordSecretIssuance, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getTaskGitBase, listTasksForRun, loadProjectSettings, saveProjectSetting } from "../../database";
import { checkTimeoutSec } from "../../check-timing";
import { sha256 } from "../../stages/contract";
import { parseReadFirstHints } from "../../stages/read-first";
import { buildRunExecutionProfile, buildRunPolicy, mapBounded } from "../../stages/run-policy";
import { classifyWriterOutput, isOutputPath } from "../../validate-output";
import { cleanCheckOutput } from "@lane-pilot/kit";
import { redactKnown, redactSecrets } from "@lane-pilot/kit";
import { SecretsNotReadyError, allowedSecretNames, secretProblem } from "../../rooms/secrets/server/secrets";
import type { VerifyResult } from "../../validate-output";
import { fileAllowedByOwns, fileBlockedByNeverTouch } from "@lane-pilot/kit";
import { isLiveDecision, LIVE_FOLDER_RECEIPT } from "../../live-folder";
import { taskFamily } from "../../failure-class";
import { bookkeepingSetting, filterOwnershipNoise } from "@lane-pilot/settings-catalog";
import { findUnownedChanges, findUnownedRunChanges, resolveRunOwnershipScope } from "../../verification/ownership";
import { recordGateEvaluation } from "../stage-records";
import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { stringAt } from "../values";
import { outputText, writerPatchFromOutput } from "../writer-task";
import type { ServerCore } from "../core";
import type { Services } from "../services";

/**
 * A verification command that fails is run once more: a check that fails once and passes on a re-run (a cold cache, a
 * port still held by the previous run) is flaky, not the writer's fault. Exit 124 is a timeout (the terminal and the
 * host sandbox both report it so) and is not repeated: it would only double the wait.
 */
export async function runWithFlakyRerun<T extends {exitCode:number}>(command:string,run:()=>Promise<T>,log:(line:string)=>void):Promise<T&{flaky?:true}> {
  const first=await run();
  if(first.exitCode===0||first.exitCode===124) return first;
  const again=await run();
  if(again.exitCode!==0) return first;
  log(`verification command passed on re-run (flaky): ${command}`);
  return {...again,flaky:true};
}

/**
 * The baseline dirt an attempt's changes are measured against: everything the contract does not own, plus owned files
 * no earlier attempt of this task family produced. Only edits an earlier attempt of the same task family produced
 * leave the baseline, so an in-place redispatch counts its family's leftover work as produced, while owner or
 * other-task dirt in an owned file is never counted as produced.
 */
export function familyDirtBaseline(task:Pick<TaskV2,"owns_paths"|"never_touch">, dirtBefore:import("../../cli-outcome").DirtSnapshot[], familyProduced:ReadonlySet<string> = new Set<string>()):import("../../cli-outcome").DirtSnapshot[] {
  return dirtBefore.filter((row) => {
    const owned = fileAllowedByOwns(row.path, task.owns_paths) && !fileBlockedByNeverTouch(row.path, task.never_touch);
    return !(owned && familyProduced.has(row.path));
  });
}

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

  async function runVerification(config: PrototypeConfig, task: TaskV2, runId?:string, writerThreadId?:string, options?:{ background?:boolean; jobKey?:string }): Promise<Array<VerifyResult & {
    sandboxBackend:string|null; policySha256:string|null; workspacePath:string; flaky?:true;
    /** The host call itself failed (worker killed, host offline): the command's own verdict is unknown. */
    hostError?:true;
  }>> {
    const policy=runId?runPolicyFor(runId):buildRunPolicy(loadProjectSettings(db,config.projectId));
    const verificationScopes=runId?getRunSettingsScopes(db,runId):[];
    // Secrets a check declares (Env Catalog, J2): only declared ones the project list leaves open are fetched, and only their own check gets them.
    const declaredSecrets=[...new Set(task.verification.flatMap((command)=>command.secrets??[]))];
    const secrets=declaredSecrets.length?await ctx.secrets.resolve({declared:declaredSecrets,allowed:allowedSecretNames(loadProjectSettings(db,config.projectId,verificationScopes))}):null;
    if(secrets&&secretProblem(secrets).length) throw new SecretsNotReadyError(secretProblem(secrets));
    return mapBounded(task.verification,policy.pools.verification,async(command)=>{
      const release=await services.runWriterPool.acquire(`verification:${runId??config.projectId}`,policy.pools.verification);
      try {
      return await runWithFlakyRerun(command.command,async()=>{
      const backend=(loadProjectSettings(db,config.projectId,verificationScopes)["sandbox.backend"] as "auto"|"macos-seatbelt"|"linux-bubblewrap"|undefined) ?? "auto";
      // The sandbox gives a command 120 s when the task names no limit; waiting only 30 s cut longer checks short.
      // History widens it for a check that is slow in this project: max(that, p95 of its last 20 green runs x 2), capped.
      const timeoutSec=checkTimeoutSec(db,config.projectId,command.command,command.timeout_sec ?? 120);
      const startedAt=Date.now();
      // A timeout (124) and a host that failed say nothing about how long the check takes: not kept.
      const recorded=<T extends {exitCode:number;hostError?:true}>(result:T):T=>{
        if(result.exitCode!==124&&!result.hostError) try { recordCheckDuration(db,{projectId:config.projectId,command:command.command,durationMs:Date.now()-startedAt,exitCode:result.exitCode}); } catch { /* history is a hint only */ }
        return result;
      };
      // A check with secrets runs through the host call, not a BB terminal: a terminal's command line and screen would carry the values.
      const env=Object.assign({},...(command.secrets??[]).map((name)=>secrets?.byName[name]??{})) as Record<string,string>;
      const hasSecrets=Object.keys(env).length>0;
      // Who was given which name, for which check; the value is never written (audit 2026-10-08, S1).
      if(hasSecrets) for(const name of command.secrets??[]) {
        if(!secrets?.byName[name]) continue;
        try { recordSecretIssuance(db,{projectId:config.projectId,runId,taskId:task.id,consumer:"check",threadId:writerThreadId,checkCommand:command.command,secretName:name,hostId:config.hostId}); }
        catch(cause) { bb.log.warn(`secret issuance journal: ${cause instanceof Error?cause.message:String(cause)}`); }
        bb.log.info(`secret ${name} given to a check of ${task.id} (${runId??"-"})`);
      }
      const inTerminal=writerThreadId&&!hasSecrets ? await runInWriterTerminal({config,writerThreadId,workspacePath:task.project_cwd,cwd:command.cwd,
        command:command.command,backend,timeoutSec}).catch((cause:unknown)=>{
          bb.log.warn(`verification terminal failed, running on the host: ${cause instanceof Error?cause.message:String(cause)}`);
          return null;
        }) : null;
      if (inTerminal) return recorded({command:command.command,exitCode:inTerminal.exitCode,stdout:redactKnown(inTerminal.stdout),stderr:redactKnown(inTerminal.stderr),
        sandboxBackend:inTerminal.backend,policySha256:inTerminal.policySha256,workspacePath:inTerminal.workspacePath});
      const ran = await host.call("runSandboxedCommand", {
        requestedHostId: config.hostId,
        workspacePath:task.project_cwd,
        backend,
        command:command.command,
        cwd: command.cwd,
        timeoutSec,
        ...(hasSecrets ? { env } : {}),
        // A background job is kept by the host with its input: a check with secrets runs as a plain call instead.
      }, { hostId:config.hostId, timeoutMs:(timeoutSec + 15) * 1000, ...(options?.background && !hasSecrets ? { job:true, ...(options.jobKey ? { jobKey:options.jobKey } : {}) } : {}) }).catch((cause: unknown) => ({
        hostId: config.hostId,
        exitCode: 1,
        stdout: "",
        stderr: hasSecrets ? redactSecrets(cause instanceof Error ? cause.message : String(cause), Object.values(env)) : cause instanceof Error ? cause.message : String(cause),
        backend:null as "macos-seatbelt"|"linux-bubblewrap"|null,
        policySha256:null as string|null,
        workspacePath:task.project_cwd,
        hostError:true as const,
      }));
      if (ran.hostId !== config.hostId) {
        return {command:command.command,exitCode:1,stdout:"",stderr:"sandbox result host did not match the configured host",
          sandboxBackend:null,policySha256:null,workspacePath:task.project_cwd};
      }
      // The host masks them already; a second pass here costs nothing and covers an older host.
      // Any check also loses the values this process handed to another run (redactKnown).
      const mask=(text:string)=>redactKnown(hasSecrets?redactSecrets(text,Object.values(env)):text);
      return recorded({command:command.command,exitCode:ran.exitCode,stdout:typeof ran.stdout==="string"?mask(ran.stdout):"",stderr:typeof ran.stderr==="string"?mask(ran.stderr):"",
        sandboxBackend:ran.backend,policySha256:ran.policySha256,workspacePath:ran.workspacePath,...("hostError" in ran?{hostError:true as const}:{})});
      },(line)=>bb.log.info(line));
      } finally { release(); }
    });
  }

  async function persistWriterAcceptance(input: {
    config:PrototypeConfig; task:TaskV2; runId:string; taskId:string; attempt:number;
    attemptId:string; pmThreadId:string; writerThreadId:string; output:string; verification:VerifyResult[];
    emergencyFallback?:{reason:string;primaryAttemptId:string;providerId:string;model:string};
    review?:"passed"|"not_required";
    /** Shape-only gates that did not reject (a missing expected output with green checks), and the writer's turns. */
    warnings?:string[]; turns?:number;
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
      ...(isLiveDecision(getAttempt(db, input.attemptId)?.workspace_decision) ? { workspace:LIVE_FOLDER_RECEIPT } : {}),
      ownsPaths:input.task.owns_paths, readFirst:parseReadFirstHints(input.task.read_first),
      output:input.output, verification:input.verification,
      runV2:buildRunExecutionProfile(input.task.risk,runPolicyFor(input.runId)),
      reasoning:reasoningTrace ? [reasoningTrace] : [],
      emergencyFallback:input.emergencyFallback ?? null,
      ...(input.warnings?.length ? { warnings:input.warnings } : {}),
      ...(input.turns ? { turns:input.turns } : {}),
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

  /** What the writer's own thread did (file edits, commands, tool calls), as one text; null when its events cannot be read. */
  async function writerTrace(threadId:string):Promise<string|null> {
    const listed = await listThreadEventsRaw(bb, { threadId, order:"desc", limit:"500" } as never).catch(() => null);
    if (!listed || !listed.ok) return null;
    return listed.events.map((event) => {
      // Only what the writer did: edited paths, command text and tool arguments. A command's output is no touch —
      // a plain `ls` listed index.md and the writer was blamed for the PM's edit (drill 2026-10-07, 0.1.179).
      const item = (event as { data?: { item?: Record<string, unknown> } })?.data?.item;
      if (!item) return "";
      if (item.type === "fileChange") return JSON.stringify(item.changes ?? item.path ?? item);
      if (item.type === "commandExecution") return String(item.command ?? "");
      if (item.type === "toolCall") return JSON.stringify(item.arguments ?? item.input ?? "");
      return "";
    }).join("\n");
  }

  async function validateWriterResult(input: {
    config:PrototypeConfig; projectId:string; runId:string; taskId:string; attempt:number; task:TaskV2; writerThreadId:string; attemptId:string; dirtBefore:import("../../cli-outcome").DirtSnapshot[];
  }): Promise<{ status:"accepted"|"empty_output"|"validation_failed"; reason?:string; output:string; produced:string[]; verification:VerifyResult[]; checkLogPath?:string; runV2?:ReturnType<typeof buildRunExecutionProfile>;
    /** Receipt warnings of an accepted result (a shape-only gate that did not reject). */
    warnings?:string[];
    /** Hash of the content of the files the attempt changed: two turns with the same one left the diff as it was. */
    diffKey?:string }> {
    const output = await bb.sdk.threads.output({ threadId:input.writerThreadId });
    // J-11: the writer's answer is checked before it is stored with the attempt (shadow by default: recorded, never blocks).
    const guarded = ctx.outputGuard ? await ctx.outputGuard({ kind:"writer", text:outputText(output), projectId:input.projectId, runId:input.runId, subject:input.taskId }) : null;
    if (guarded?.blocked) {
      recordGateEvaluation(db,{...input,gate:"validate",status:"rejected",input:JSON.stringify(input.task),summary:{reason:`output_guard_blocked:${guarded.reason}`}});
      return { status:"validation_failed", reason:`verdict_block:output-guard: the writer's answer ${guarded.reason === "secret" ? "contains what looks like a secret value" : "contains instructions aimed at the agent that reads it"}; it was not stored | stopped, not redone: tell the owner before sending anything again`, output:guarded.text, produced:[], verification:[] };
    }
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
    if (!liveFolder) for (const row of db.prepare("SELECT id, task_id FROM lane_pilot_attempt WHERE run_id=? AND id<>?")
      .all(input.runId, input.attemptId) as Array<{ id:string; task_id:string }>) {
      if (taskFamily(row.task_id) !== taskFamily(input.taskId)) continue;
      const saved = await bb.storage.kv.get(`writer-produced:${row.id}`).catch(() => null);
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
      if (trace !== null) {
        const foreign = produced.filter((path) => !fileAllowedByOwns(path, input.task.owns_paths) && !trace.includes(path) && !trace.includes(path.split("/").pop() ?? path));
        if (foreign.length) {
          ctx.log(`Lane Pilot: ${foreign.join(", ")} changed in the live folder during ${input.taskId}, not by its writer; left out of its check`);
          produced = produced.filter((path) => !foreign.includes(path));
        }
      }
    }
    const diffKey = sha256(produced.map((path) => `${path}:${dirt.snapshots.find((row) => row.path === path)?.sha256 ?? ""}`).join("\n"));
    // The files this attempt's changes produced, for the next attempt of the task family: only these may later
    // leave a redispatch's dirt baseline.
    void bb.storage.kv.set(`writer-produced:${input.attemptId}`, produced as never).catch(() => undefined);
    // A task rejected before it ever ran (preflight, plan critique) claims no files; its contract may even be unsafe
    // («../other-repo/» in owns_paths), and kept in the scope it failed every later task of the run (BB-сервис 2026-10-05).
    const attempted = new Set((db.prepare("SELECT DISTINCT task_id FROM lane_pilot_attempt WHERE run_id=?").all(input.runId) as Array<{ task_id:string }>).map((row) => row.task_id));
    const runTasks = listTasksForRun(db,input.runId).filter((row) => row.id === input.taskId || attempted.has(row.id));
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
        requestedHostId:input.config.hostId,projectCwd:input.task.project_cwd,baseSha:base.headSha,compareCommitted:true,bookkeeping,
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
    const unowned = runUnowned.length ? [...new Set([...runUnowned,...findUnownedChanges(checkedPaths,input.task)])].sort() : [];
    if (unowned.length) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"rejected",input:JSON.stringify(input.task),summary:{unownedCount:unowned.length}});
      recordGateEvaluation(db,{...input,gate:"validate",status:"skipped",input:JSON.stringify(input.task),summary:{reason:"ownership_rejected"}});
      return { status:"validation_failed", reason:`writer changed paths outside owns_paths or inside never_touch: ${unowned.join(", ")}`,
        output:outputText(output), produced:checkedPaths, verification:[], diffKey };
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
    let verifies:Awaited<ReturnType<typeof runVerification>>;
    try { verifies = await runVerification(input.config, input.task, input.runId, input.writerThreadId); }
    catch (cause) {
      // A secret the checks need went away or was taken off the allow list: the task waits for it, no attempt is spent.
      if (!(cause instanceof SecretsNotReadyError)) throw cause;
      recordGateEvaluation(db,{...input,gate:"verification",status:"skipped",input:JSON.stringify(input.task),summary:{reason:cause.message}});
      return { status:"validation_failed", reason:cause.message, output:outputText(output), produced:checkedPaths, verification:[], diffKey };
    }
    recordGateEvaluation(db,{...input,gate:"verification",status:verifies.length===0?"skipped":verifies.every((row)=>row.exitCode===0)?"passed":"failed",
      input:JSON.stringify(input.task),summary:{commandCount:verifies.length,failedCount:verifies.filter((row)=>row.exitCode!==0).length}});
    // A failing check's full output goes under the task folder logs/, so the retry reads it instead of rerunning blind.
    const failedVerify = verifies.find((row) => row.exitCode !== 0);
    let checkLogPath:string|undefined;
    if (failedVerify) {
      const slug = failedVerify.command.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "check";
      checkLogPath = `.agents/plans/items/${input.taskId}/logs/${slug}.log`;
      const saved = await bb.sdk.files.write({ hostId:input.config.hostId, rootPath:input.task.project_cwd, path:`${input.task.project_cwd}/${checkLogPath}`,
        content:`$ ${failedVerify.command}\nexit ${failedVerify.exitCode}\n\n${cleanCheckOutput(failedVerify.stdout)}\n${cleanCheckOutput(failedVerify.stderr)}`.trim() + "\n",
        contentEncoding:"utf8", createParents:true, expectedSha256:null }).catch(() => null);
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
      return { status:classified.state, reason:classified.reason, output:answerText, produced:checkedPaths, verification:verifies, diffKey,
        ...(checkLogPath ? { checkLogPath } : {}) };
    }
    recordGateEvaluation(db,{...input,gate:"validate",status:"passed",input:JSON.stringify(input.task),summary:{producedCount:checkedPaths.length,...(classified.warnings?.length?{warnings:classified.warnings}:{})}});
    return { status:"accepted", output:outputText(output), produced:checkedPaths, verification:verifies, diffKey,
      ...(classified.warnings?.length ? { warnings:classified.warnings } : {}),
      runV2:buildRunExecutionProfile(input.task.risk,runPolicyFor(input.runId)) };
  }

  return { runVerification, persistWriterAcceptance, validateWriterResult };
}
