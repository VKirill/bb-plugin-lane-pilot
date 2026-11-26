import { SETTING_WORKER_STRICT_USER, SETTING_WORKER_USER } from "@lane-pilot/settings-catalog";
import { sshKeysOpen, sshMaskEvidence } from "@lane-pilot/models";
import { runOnHost } from "@lane-pilot/host-calls";
import { buildRunPolicy, mapBounded } from "../../../tasks";
import type { PrototypeConfig, TaskV2 } from "../../../contracts";
import { recordCheckDuration, recordSecretIssuance, getRunSettingsScopes, loadProjectSettings } from "../../../storage";
import { checkTimeoutSec, orderChecksForFailFast } from "./check-timing";
import { outputHashes, pollPause } from "@lane-pilot/kit";
import { bestEffort, redactKnown, redactSecrets } from "@lane-pilot/kit";
import { SecretsNotReadyError, allowedSecretNames, secretProblem } from "../../../secrets/server";
import type { VerifyResult } from "../../../tasks";
import { beginChecks, checksMoved } from "../../../runs";
import { DEFAULT_WORKER, readingFrom } from "../../../verification";
import type { ServerCore } from "../../../contracts/server";
import type { WriterSpawnApi } from "./spawn";
import type { WriterStateApi } from "./state";
import { createVerifyAcceptance } from "./verify-acceptance";
import { createVerifyValidate } from "./verify-validate";
import { failIfNoTestRan, runWithFlakyRerun, type FlakyEvidence } from "./verify-flaky";
import { REVISION_PROBE, parseRevisionProbe, type CheckRevision } from "../../models/verify";
/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
  runWriterPool: WriterStateApi["runWriterPool"];
  workspaceDirt: WriterSpawnApi["workspaceDirt"];
}

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
export { type CheckRevision, REVISION_PROBE, parseRevisionProbe, familyDirtBaseline } from "../../models/verify";
export { runWithFlakyRerun, failIfNoTestRan } from "./verify-flaky";
export { acceptanceReceiptBase } from "./verify-acceptance";
export function createWriterVerify(ctx: ServerCore, services: Services) {
  const { bb, db, host, runPolicyFor } = ctx;

  /**
   * A writer's check runs in a BB terminal of the writer's thread, inside the same sandbox, so the owner can open it
   * and watch; BB reports its output and exit code. Null when terminals are unavailable: the caller falls back.
   */
  async function runInWriterTerminal(input:{config:PrototypeConfig; writerThreadId:string; workspacePath:string; cwd:string; command:string; backend:"auto"|"macos-seatbelt"|"linux-bubblewrap"; timeoutSec:number; sshKeys?:boolean; protectedRoots?:boolean}) {
    const terminals=(bb.sdk as { terminals?: typeof bb.sdk.terminals }).terminals;
    if (!terminals?.create) return null;
    // Every machine variable of the project (BB's global ones and the project's own) reaches the check; BB puts
    // them into the terminal, and only their names travel here.
    const machineEnv=await bestEffort(ctx.log, "verification machine environment", Promise.resolve().then(()=>bb.sdk.projects.machineEnvironment({projectId:input.config.projectId})), null);
    const passEnv=(machineEnv?.variables??[]).map((variable)=>variable.name);
    const protectedRoots = input.protectedRoots ?? true;
    const prepared=await host.call("sandboxCommandLine",{requestedHostId:input.config.hostId,workspacePath:input.workspacePath,cwd:input.cwd,
      command:input.command,backend:input.backend,passEnv,...(input.sshKeys?{sshKeys:true}:{}),...(protectedRoots?{protectedRoots:true}:{})},{hostId:input.config.hostId,timeoutMs:30_000});
    if (prepared.hostId!==input.config.hostId) throw new Error("sandbox result host did not match the configured host");
    // The roots manifest (SMA m_ck_isolated): the host hashed .git/.agents/.cls at prepare and hashes them again at release.
    let exitCode = 1;
    let stdoutText = "";
    let stderrText = "";
    let terminalId = "";
    let timedOutOrDisconnected = false;
    try {
      let session;
      try {
        session=await terminals.create({cols:160,rows:48,scope:{kind:"thread",threadId:input.writerThreadId},
          start:{mode:"command",command:prepared.commandLine},title:`Lane Pilot check: ${input.command.slice(0,60)}`});
      } catch (cause) {
        bb.log.warn(`verification terminal unavailable, running on the host: ${cause instanceof Error?cause.message:String(cause)}`);
        return null;
      }
      terminalId = session.id;
      bb.log.info(`verification in terminal ${session.id} of thread ${input.writerThreadId}: ${input.command.slice(0,120)}`);
      const deadline=Date.now()+(input.timeoutSec+15)*1000;
      while (session.status!=="exited"&&session.status!=="disconnected"&&Date.now()<deadline) {
        await new Promise((resolve)=>setTimeout(resolve,pollPause(1_500)));
        session=await terminals.get({terminalId:session.id});
      }
      const read=await terminals.output({terminalId:session.id,tailBytes:200_000}).catch((cause: unknown) => { ctx.log(`verification terminal output unreadable: ${cause instanceof Error?cause.message:String(cause)}`); return {chunks:[] as Array<{dataBase64:string}>}; });
      stdoutText = read.chunks.map((chunk)=>Buffer.from(chunk.dataBase64,"base64").toString("utf8")).join("");
      if (session.status!=="exited") {
        await bestEffort(ctx.log, "verification terminal close", terminals.close({terminalId:session.id,mode:"force"}), undefined);
        exitCode = 124;
        stderrText = session.status==="disconnected"?"verification terminal disconnected":`verification timed out after ${input.timeoutSec}s`;
        timedOutOrDisconnected = true;
      } else {
        bb.log.info(`verification terminal ${session.id} exited ${session.exitCode}`);
        exitCode = session.exitCode??1;
      }
    } finally {
      const released=await bestEffort(ctx.log, "verification sandbox release", host.call("sandboxRelease",{requestedHostId:input.config.hostId,...prepared.cleanup,
        ...(protectedRoots&&prepared.rootsBefore?{workspacePath:input.workspacePath,rootsBefore:prepared.rootsBefore}:{})},{hostId:input.config.hostId,timeoutMs:30_000}), null);
      if (terminalId) {
        const rootsManifest = released?.rootsManifest;
        return {exitCode,stdout:stdoutText,stderr:timedOutOrDisconnected?stderrText:"",backend:prepared.backend,policySha256:prepared.policySha256,
          workspacePath:prepared.workspacePath,terminalId,maskedSsh:prepared.maskedSsh,...(rootsManifest?{rootsManifest}:{})};
      }
    }
    return null;
  }

  async function runVerification(config: PrototypeConfig, task: TaskV2, runId?:string, writerThreadId?:string, options?:{ background?:boolean; jobKey?:string; isolated?:boolean;
    /** The workspace is a throwaway copy (the attempt's worktree, a landing or revert worktree): a check that changed .git/.agents/.cls fails. */
    throwaway?:boolean }): Promise<Array<VerifyResult & {
    sandboxBackend:string|null; policySha256:string|null; workspacePath:string; flaky?:true; flakyEvidence?:FlakyEvidence; reran?:true;
    /** The host call itself failed (worker killed, host offline): the command's own verdict is unknown. */
    hostError?:true;
    /** The commit the checks ran on and how many files were not committed then; null when git could not say. */
    revision?:CheckRevision;
    /** The five required measures (SMA m_ck_required): recipe source, copy, cleared env, closed publication, roots manifest. */
    recipe?:string; copy?:string; env?:"cleared"; publication?:"closed";
    rootsSha256?:string; rootsChanged?:boolean; rootsPartial?:boolean; rootsGit?:string;
  }>> {
    const policy=runId?runPolicyFor(runId):buildRunPolicy(loadProjectSettings(db,config.projectId));
    const verificationScopes=runId?getRunSettingsScopes(db,runId):[];
    // Secrets a check declares (Env Catalog, J2): only declared ones the project list leaves open are fetched, and only their own check gets them.
    const declaredSecrets=[...new Set(task.verification.flatMap((command)=>command.secrets??[]))];
    const secrets=declaredSecrets.length?await ctx.secrets.resolve({declared:declaredSecrets,allowed:allowedSecretNames(loadProjectSettings(db,config.projectId,verificationScopes))}):null;
    if(secrets&&secretProblem(secrets).length) throw new SecretsNotReadyError(secretProblem(secrets));
    const commands:TaskV2["verification"]=task.verification;
    // Which revision was checked, and how dirty the copy was (Matvey: «can you name its base without opening the workspace»):
    // on the hub this says how many checks ran in a copy with loose files, so whether a clean copy is needed is read from data.
    // A probe that read nothing (no git, the host did not answer) names no revision: the row goes without one.
    const revision=await bestEffort(ctx.log, "verification revision probe", Promise.resolve().then(()=>runOnHost(host,{hostId:config.hostId,cwd:task.project_cwd,command:REVISION_PROBE,timeoutSec:15}))
      .then((row)=>parseRevisionProbe(row?.stdout??"")), {head:null,dirty:null});
    // A background sweep (the landing suite) must not slow a live run: its own pool key, one check at a time, and below it no check-duration history is written.
    const isolated=options?.isolated===true;
    const pool=isolated?`verification:landing-suite:${config.projectId}`:`verification:${runId??config.projectId}`;
    const poolLimit=isolated?1:policy.pools.verification;
    // The watcher reads this: the attempt stays «running» with its writer idle while its checks wait or run (self-repair.ts).
    const endChecks=writerThreadId?beginChecks(writerThreadId,pool):()=>undefined;
    // checks.fail_fast (default on): highest expected fail-cost first; after the first non-zero exit nothing new
    // starts (running checks finish). Results go back out in contract order; a check that never started is simply absent.
    const failFast=String(loadProjectSettings(db,config.projectId,verificationScopes)["checks.fail_fast"] ?? "on")!=="off";
    const entries=failFast?orderChecksForFailFast(db,config.projectId,commands,task.project_cwd):commands.map((check,index)=>({check,index}));
    let halt=false;
    try {
    const rawResults=await mapBounded(entries,poolLimit,async(entry)=>{
      if(failFast&&halt)return undefined;
      const command=entry.check;
      const release=await services.runWriterPool.acquire(pool,poolLimit);
      checksMoved(pool);
      try {
      // The machine the check runs on, read right before each attempt (never during it): the host that runs it, not this process.
      const sampleMachine=async()=>{
        try { return readingFrom(await host.call("diskFree",{requestedHostId:config.hostId,path:task.project_cwd,machine:true},{hostId:config.hostId,timeoutMs:5_000})); }
        catch { return null; }
      };
      const outcome=failIfNoTestRan(await runWithFlakyRerun(command.command,async()=>{
      const backend=(loadProjectSettings(db,config.projectId,verificationScopes)["sandbox.backend"] as "auto"|"macos-seatbelt"|"linux-bubblewrap"|undefined) ?? "auto";
      // The sandbox gives a command 900 s when the task names no limit; waiting only 120 s cut longer suites short.
      // History widens it for a check that is slow in this project: max(that, p95 of its last 20 green runs x 2), capped.
      const timeoutSec=checkTimeoutSec(db,config.projectId,{command:command.command,cwd:command.cwd,root:task.project_cwd},command.timeout_sec ?? 900);
      const startedAt=Date.now();
      // A timeout (124) and a host that failed say nothing about how long the check takes: not kept.
      const recorded=<T extends {exitCode:number;hostError?:true}>(result:T):T=>{
        // A timeout is kept as a censored row (duration_ms = the limit it died at): fail-fast ordering counts it as a
        // failure and the rank-12 escalator raises this check's next timeout; green-only history ignores it.
        if(!result.hostError&&!isolated) try { recordCheckDuration(db,{projectId:config.projectId,command:command.command,cwd:command.cwd,root:task.project_cwd,durationMs:Date.now()-startedAt,exitCode:result.exitCode}); } catch { /* history is a hint only */ }
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
      // The strict worker (worker.strict_user on): the check runs as worker.user through the host call, never in the owner's terminal.
      const checkSettings=loadProjectSettings(db,config.projectId,verificationScopes);
      const asUser=String(checkSettings[SETTING_WORKER_STRICT_USER] ?? "off")==="on" ? String(checkSettings[SETTING_WORKER_USER] ?? DEFAULT_WORKER) : null;
      // verification.ssh_keys (project, unset = off): ~/.ssh is masked in checks unless the project says on.
      const sshKeys=sshKeysOpen(checkSettings);
      const sshNote=(exitCode:number,stdout:string,stderr:string,masked:boolean|undefined)=>{
        const line=sshMaskEvidence({projectId:config.projectId,exitCode,output:`${stdout}\n${stderr}`,masked});
        return line?`${stderr}\n${line}`.trim():stderr;
      };
      const inTerminal=writerThreadId&&!hasSecrets&&!asUser ? await runInWriterTerminal({config,writerThreadId,workspacePath:task.project_cwd,cwd:command.cwd,
        command:command.command,backend,timeoutSec,sshKeys,protectedRoots:true}).catch((cause:unknown)=>{
          bb.log.warn(`verification terminal failed, running on the host: ${cause instanceof Error?cause.message:String(cause)}`);
          return null;
        }) : null;
      if (inTerminal) return recorded({command:command.command,exitCode:inTerminal.exitCode,stdout:redactKnown(inTerminal.stdout),stderr:sshNote(inTerminal.exitCode,inTerminal.stdout,redactKnown(inTerminal.stderr),inTerminal.maskedSsh),
        sandboxBackend:inTerminal.backend,policySha256:inTerminal.policySha256,workspacePath:inTerminal.workspacePath,timeoutSec,...(inTerminal.rootsManifest?{rootsManifest:inTerminal.rootsManifest}:{})});
      const ran = await host.call("runSandboxedCommand", {
        requestedHostId: config.hostId,
        workspacePath:task.project_cwd,
        backend,
        command:command.command,
        cwd: command.cwd,
        timeoutSec,
        protectedRoots:true,
        ...(hasSecrets ? { env } : {}),
        ...(asUser ? { asUser } : {}),
        ...(sshKeys ? { sshKeys: true } : {}),
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
      return recorded({command:command.command,exitCode:ran.exitCode,stdout:typeof ran.stdout==="string"?mask(ran.stdout):"",stderr:typeof ran.stderr==="string"?sshNote(ran.exitCode,typeof ran.stdout==="string"?ran.stdout:"",mask(ran.stderr),"maskedSsh" in ran?ran.maskedSsh:undefined):"",
        sandboxBackend:ran.backend,policySha256:ran.policySha256,workspacePath:ran.workspacePath,timeoutSec,...("hostError" in ran?{hostError:true as const}:{}) ,...("rootsManifest" in ran&&ran.rootsManifest?{rootsManifest:ran.rootsManifest}:{})});
      },(line)=>bb.log.info(line),sampleMachine));
      // The roots manifest (SMA m_ck_isolated): a check that changed .git/.agents/.cls fails when this workspace is
      // a throwaway copy; a partial manifest is told on the receipt, never a verdict.
      const roots="rootsManifest" in outcome ? outcome.rootsManifest : undefined;
      if(roots){
        const changed=roots.changed===true&&roots.partial!==true;
        Object.assign(outcome,{rootsSha256:roots.after,rootsChanged:changed,rootsPartial:roots.partial===true?true:undefined,rootsGit:roots.git});
        if(changed&&options?.throwaway){outcome.exitCode=outcome.exitCode||1;
          outcome.stderr=`${outcome.stderr??""}\nprotected roots changed (.git/.agents/.cls): a check must not alter them in a throwaway copy`.trim();}
      }
      if(failFast&&outcome.exitCode!==0)halt=true;
      return outcome;
      } finally { checksMoved(pool); release(); }
    });
    const skipped=rawResults.filter((result)=>result===undefined).length;
    const orderedResults=rawResults
      .map((result,pos)=>({result,index:entries[pos]!.index}))
      .filter((row):row is {result:NonNullable<typeof row.result>;index:number}=>row.result!==undefined)
      .sort((a,b)=>a.index-b.index)
      // Every check receipt tells the five measures (SMA m_ck_required): recipe source, copy, env, publication, roots.
      .map((row)=>({...row.result,...outputHashes(row.result),recipe:"from snapshot",copy:options?.throwaway?"worktree":"none: this checkout",env:"cleared" as const,publication:"closed" as const,
        ...(revision.head!==null||revision.dirty!==null?{revision}:{})}));
    if(skipped){const first=orderedResults.find((row)=>row.exitCode!==0);
      if(first)first.stderr=`${first.stderr??""}\nchecks.fail_fast: ${skipped} check(s) not started after the first non-zero exit`.trim();}
    return orderedResults;
    } finally { endChecks(); }
  }

  const { persistWriterAcceptance, writerTrace } = createVerifyAcceptance({ ctx, db });
  const { validateWriterResult } = createVerifyValidate({ ctx, db, services, runVerification, writerTrace, persistWriterAcceptance });
  return { runVerification, persistWriterAcceptance, validateWriterResult };
}

export type WriterVerifyApi = ReturnType<typeof createWriterVerify>;
