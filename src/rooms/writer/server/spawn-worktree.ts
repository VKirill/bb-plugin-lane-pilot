import { runOnHost } from "@lane-pilot/host-calls";
import { bestEffort, stringAt } from "@lane-pilot/kit";
import { parseDirtSnapshots } from "../cli-outcome";
import type { DirtSnapshot } from "../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { getAttempt, getRun, setAttemptEnvironment, setAttemptHolderThread, setAttemptWorkspace } from "../../storage";
import { configuredSetting } from "../../contracts/server";
import { WORKSPACE_DIRT_COMMAND, requireManagedWorktreeProvider, resolveManagedWorkspace, waitManagedWorktreeReady, waitProviderEnvironment, providerListed, providerSwitchOn } from "../../verification";
import { LANE_WORKTREE_PROVIDER_ID } from "../../native-agent/server";
import { fullAccessSpawn, holderSpawnKey } from "../../platform/server";
import { WriterSelectionError, projectRoleField } from "../../runs/server";
import { writerExecutionSelection } from "@lane-pilot/models";
import { spawnWithSeam } from "../spawn-seam";
import type { RollbackApi } from "../../rollback/server/rollback";
import type { ReconcileApi } from "../../stability/server/reconcile";
import type { createProviderGate } from "../../verification";
import type { ProviderEnvironment, SpawnInput, WriterEnvironment } from "./spawn-types";
import { hasOtherRootSource, inPlaceEnvironment, isProjectRootCheckout, providerRefusal, worktreeCreateError } from "./spawn-probe";

export function createSpawnWorktree(deps:{
  bb:ServerCore["bb"]; db:ServerCore["db"]; host:ServerCore["host"];
  liveFolder:{ isLiveFolder(runId:string|undefined, hostId:string, folder:string):Promise<boolean>;
    liveSnapshot(hostId:string, folder:string):Promise<{ ok:true; paths:string[]; snapshots:DirtSnapshot[] } | { ok:false; reason:string }> };
  providerGate:ReturnType<typeof createProviderGate>;
  services:{ rollback?:RollbackApi; recoverLostHolderThread:ReconcileApi["recoverLostHolderThread"] };
}) {
  const { bb, db, host, liveFolder, providerGate } = deps;

  /** Why this attempt does not use the provider (null: it does). Anything but the owner's own switch is one log line. */
  async function providerSkipReason(projectId:string, hostId:string, attemptId:string, settings:Record<string,unknown>):Promise<string|null> {
    if (!providerSwitchOn(settings["workspace.provider"])) return "switched off by workspace.provider";
    const reason = !await providerGate.usable(hostId) ? "switched off on this machine after three provider errors"
      : !await providerListed((args) => bb.sdk.environments.listProviders(args), LANE_WORKTREE_PROVIDER_ID, projectId, hostId) ? "this BB does not offer it"
      : null;
    if (reason) bb.log.info(`Lane Pilot writer ${attemptId}: worktree provider not used (${reason}); the old worktree path`);
    return reason;
  }

  /**
   * The attempt's worktree as a BB environment of Lane Pilot's own provider. Lane Pilot makes the worktree first (the
   * packet, the task folder and the dirt baseline are read from it before the thread exists) and the provider adopts it,
   * so no holder thread and no model turn is spent on it. Null, with one log line, whenever the old path should serve
   * the attempt: the owner's switch, a core without the API, a machine whose provider was switched off, a worktree that
   * could not be made (the old path makes it again, or the managed one).
   */
  async function prepareProviderWorktree(input:{projectId:string;runId:string;taskId:string;attemptId:string;config:PrototypeConfig;task:TaskV2}, settings:Record<string,unknown>,
    bound:{workspace_path:string|null}|null|undefined, basePath:string, decision:unknown):Promise<{path:string;dirtBefore:DirtSnapshot[]|null}|null> {
    const hostId=input.config.hostId;
    if (await providerSkipReason(input.projectId,hostId,input.attemptId,settings)) return null;
    if (bound?.workspace_path) return {path:bound.workspace_path,dirtBefore:null};
    const created=await bestEffort(bb.log, "writer worktree create", host.call("gitCreateWorktree",{requestedHostId:hostId,basePath,name:input.attemptId,taskId:input.taskId},{hostId,timeoutMs:60_000,worktreeOwner:{kind:"attempt",id:input.attemptId}}), null);
    if(!created||created.status!=="ready"||!created.path) {
      bb.log.info(`Lane Pilot writer ${input.attemptId}: no worktree for the provider (${created?.reason ?? "no answer"}); the old worktree path`);
      return null;
    }
    await bestEffort(bb.log, "writer worktree prepare", host.call("gitPrepareWorktree",{requestedHostId:hostId,basePath,worktreePath:created.path,
      ownsBarrier:configuredSetting(settings,"writer.owns_barrier")!=="off",ownsPaths:input.task.owns_paths,neverTouch:input.task.never_touch},
      {hostId,timeoutMs:600_000}), undefined);
    // Until the attempt row holds the path no sweep knows the worktree (about 2 GB each): a refusal below removes it here.
    const dropWorktree=async (reason:string) => {
      if (getAttempt(db,input.attemptId)?.workspace_path===created.path) return;
      await host.call("gitRemoveWorktree",{requestedHostId:hostId,basePath,worktreePath:created.path!},{hostId,timeoutMs:60_000})
        .catch((cause)=>bb.log.warn(`Lane Pilot could not remove the worktree of ${input.attemptId} after ${reason}: ${cause instanceof Error?cause.message:String(cause)}`));
    };
    const prepared=await workspaceDirt(input.config,created.path,input.runId).catch(async (cause)=>{ await dropWorktree("a baseline error"); throw cause; });
    if(!prepared.ok) { await dropWorktree("a failed baseline"); throw new WriterSelectionError(`attempt_worktree_baseline_failed:${prepared.reason}`); }
    if(!setAttemptWorkspace(db,input.attemptId,{path:created.path,environmentId:null,decision})) { await dropWorktree("a binding conflict"); throw new WriterSelectionError("attempt_workspace_cas_conflict"); }
    deps.services.rollback?.noteBase(input.attemptId,created.baseSha);
    return {path:created.path,dirtBefore:prepared.snapshots};
  }

  /**
   * Starts the writer on the provider's environment and waits for it to be ready. When BB refuses the provider, its
   * create errors or it does not come up in time, the attempt starts again on the old path over the same worktree: it
   * is not failed and not charged. The machine's error count moves on each; the third in a row switches the provider off there.
   */
  async function launchOnProvider(args:{input:{attemptId:string;config:PrototypeConfig};providerEnvironment:ProviderEnvironment;fallback:WriterEnvironment;
    launch:(target:WriterEnvironment)=>Promise<unknown>}):Promise<unknown> {
    const { input, providerEnvironment, launch } = args;
    const hostId=input.config.hostId;
    const fallBack=async (reason:string) => {
      bb.log.info(`Lane Pilot writer ${input.attemptId}: worktree provider error (${reason.replace(/\bfailed\b/gi,"error").slice(0,200)}); the old worktree path`);
      await providerGate.failed(hostId,reason);
      return await launch(args.fallback);
    };
    let spawned:unknown;
    try { spawned=await launch(providerEnvironment); }
    catch (cause) {
      if (!providerRefusal(cause)) throw cause;
      return await fallBack(cause instanceof Error ? cause.message : String(cause));
    }
    const threadId=stringAt(spawned,"id");
    if (!threadId) return spawned;
    const ready=await waitProviderEnvironment({threadId,spawnEnvironmentId:stringAt(spawned,"environmentId"),expectedPath:providerEnvironment.inputs.path,
      getThread:async (id)=>bb.sdk.threads.get({threadId:id}),getEnvironment:async (id)=>bb.sdk.environments.get({environmentId:id})});
    if (!ready.ok) {
      // The thread never started a turn (its first message waits for the environment): it goes, the worktree stays.
      await bestEffort(bb.log, "writer thread stop", bb.sdk.threads.stop({threadId}), undefined);
      await bestEffort(bb.log, "writer thread archive", bb.sdk.threads.archive({threadId}), undefined);
      return await fallBack(ready.reason);
    }
    setAttemptEnvironment(db,input.attemptId,ready.environmentId);
    await providerGate.succeeded(hostId);
    return spawned;
  }

  /** Whether the folder is a subfolder of a larger git repo, asked on its own host (the hub may not see the folder). */
  async function nestedInRepo(hostId:string, folder:string):Promise<boolean> {
    const ran = await bestEffort(bb.log, "writer nested repo probe", runOnHost(host, { hostId, cwd: folder, command: "git rev-parse --show-prefix", timeoutSec: 15 }), null);
    return Boolean(ran && ran.exitCode === 0 && /^[^\n]+\/\s*$/.test(ran.stdout));
  }

  async function workspaceDirt(config: PrototypeConfig, workspacePath = config.writerWorkspacePath, runId?: string): Promise<{ ok:true; paths:string[]; snapshots:DirtSnapshot[] } | { ok:false; reason:string }> {
    // A folder without git has no dirt to list: its whole content is the snapshot, and an attempt's work is the difference.
    if (await liveFolder.isLiveFolder(runId, config.hostId, workspacePath)) return liveFolder.liveSnapshot(config.hostId, workspacePath);
    // The command runs in the workspace on its own host and answers workspace-relative paths, also for a subfolder
    // of a larger repo; the server may not see that folder at all.
    const ran = await runOnHost(host, { hostId: config.hostId, cwd: workspacePath, command: WORKSPACE_DIRT_COMMAND, timeoutSec: 30, timeoutMs: 30_000 }).catch((cause: unknown) => ({
      hostId: config.hostId,
      exitCode: 1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : String(cause),
    }));
    if (ran.exitCode !== 0) {
      return { ok:false, reason:`cannot read writer-workspace git diff: ${ran.stderr || `exit ${ran.exitCode}`}` };
    }
    try {
      const parsed = JSON.parse(ran.stdout) as unknown;
      if (!Array.isArray(parsed) || parsed.some((row) => !row || typeof row !== "object"
        || typeof (row as DirtSnapshot).path !== "string" || typeof (row as DirtSnapshot).sha256 !== "string")) {
        return { ok:false, reason:"cannot snapshot writer-workspace file contents" };
      }
      const snapshots = parseDirtSnapshots(ran.stdout);
      if (snapshots.length !== parsed.length) return { ok:false, reason:"incomplete writer-workspace content snapshot" };
      return { ok:true, paths:snapshots.map((row) => row.path), snapshots };
    } catch {
      return { ok:false, reason:"invalid writer-workspace content snapshot" };
    }
  }

  /**
   * Binds the attempt to the folder the writer works in: the interrupted attempt's kept worktree, Lane Pilot's own
   * provider or worktree, BB's managed worktree through a short-lived holder, or the run's folder in place.
   */
  async function bindAttemptWorkspace(args:{
    input:SpawnInput; settings:Record<string,unknown>;
    workspaceDecision:unknown; nativeRun:boolean; ownsBarrier:boolean;
    base:string; nestedBase:boolean;
    run:NonNullable<ReturnType<typeof getRun>> & {writer_workspace_path:string};
    execution:ReturnType<typeof writerExecutionSelection>;
    writerProviderId:string;
    dirtBefore:DirtSnapshot[];
  }):Promise<{ workspacePath:string;
    environment:{type:"reuse";environmentId:string}|{type:"host";hostId:string;workspace:{type:"unmanaged";path:string}};
    providerEnvironment:ProviderEnvironment|null; dirtBefore:DirtSnapshot[] }> {
    const { input, settings, workspaceDecision, nativeRun, ownsBarrier, base, nestedBase, run, execution } = args;
    let dirtBefore = args.dirtBefore;
    let workspacePath = base;
    let environment:{type:"reuse";environmentId:string}|{type:"host";hostId:string;workspace:{type:"unmanaged";path:string}} = run.writer_environment_id && !nestedBase
      ? { type:"reuse" as const, environmentId:run.writer_environment_id }
      : { type:"host" as const, hostId:input.config.hostId, workspace:{ type:"unmanaged" as const, path:input.task.project_cwd } };
    // Set when the attempt's worktree is a BB environment of Lane Pilot's own provider; `environment` is then the old
    // path's answer for the same worktree, which the attempt falls back to.
    let providerEnvironment:ProviderEnvironment|null=null;
    if (input.continuation) {
      // The interrupted attempt's worktree is kept as it was left: its edits and its dirt baseline stay as they were.
      const continued=input.continuation;
      workspacePath=continued.workspacePath;
      environment=inPlaceEnvironment(input.config.hostId,workspacePath,continued.environmentId);
      dirtBefore=continued.dirtBefore;
      if(!setAttemptWorkspace(db,input.attemptId,{path:workspacePath,environmentId:continued.environmentId,decision:workspaceDecision})) {
        throw new WriterSelectionError("attempt_workspace_cas_conflict");
      }
    } else if ((workspaceDecision as {strategy:string}).strategy === "provision_attempt_worktree") {
      const bound=getAttempt(db,input.attemptId);
      const onProvider=bound?.workspace_path&&bound.environment_id ? null
        : await prepareProviderWorktree(input,settings,bound,base,workspaceDecision);
      if (bound?.workspace_path && bound.environment_id) {
        workspacePath=bound.workspace_path;
        environment={type:"reuse",environmentId:bound.environment_id};
      } else if (onProvider) {
        workspacePath=onProvider.path;
        if(onProvider.dirtBefore) dirtBefore=onProvider.dirtBefore;
        providerEnvironment={type:"provider",environmentProviderId:LANE_WORKTREE_PROVIDER_ID,machine:{type:"existing",hostId:input.config.hostId},
          inputs:{basePath:base,name:input.attemptId,path:workspacePath,
            ownsBarrier,ownsPaths:input.task.owns_paths,neverTouch:input.task.never_touch}};
        environment=inPlaceEnvironment(input.config.hostId,workspacePath,null);
      // BB's managed worktree forks the project's root source; a run folder that is not it (a section with its own
      // repo inside a non-git project, live sandbox 2026-10-07: «no usable git branch») needs Lane Pilot's own.
      } else if (nestedBase || (nativeRun ? !await isProjectRootCheckout(bb, input.projectId, input.config.hostId, run.writer_workspace_path, bb.log)
          : await hasOtherRootSource(bb, input.projectId, input.config.hostId, run.writer_workspace_path, bb.log))
        // BB's managed worktree starts the writer at the repo root; a folder nested in a larger repo needs the same
        // subfolder inside the worktree, which only Lane Pilot's own worktree gives (OVH live check 2026-10-07).
        || await nestedInRepo(input.config.hostId, run.writer_workspace_path)) {
        // BB's managed worktree always forks the project root; a Lane chat in a section with its own
        // repository gets a git worktree of that repository from Lane Pilot instead (~/.lane-pilot/worktrees).
        // A chat in a subfolder of a larger repo gets a worktree of that repo and works in the same subfolder there.
        if (bound?.workspace_path) {
          workspacePath=bound.workspace_path;
          environment=inPlaceEnvironment(input.config.hostId,workspacePath,bound.environment_id);
        } else {
          const created=await host.call("gitCreateWorktree",{requestedHostId:input.config.hostId,basePath:base,name:input.attemptId,taskId:input.taskId},
            {hostId:input.config.hostId,timeoutMs:60_000,worktreeOwner:{kind:"attempt",id:input.attemptId}});
          if(created.status==="ready"&&created.path) {
            workspacePath=created.path;
            await bestEffort(bb.log, "writer worktree prepare", host.call("gitPrepareWorktree",{requestedHostId:input.config.hostId,basePath:base,worktreePath:workspacePath,
              ownsBarrier,ownsPaths:input.task.owns_paths,neverTouch:input.task.never_touch},
              {hostId:input.config.hostId,timeoutMs:600_000}), undefined);
            const prepared=await workspaceDirt(input.config,workspacePath,input.runId);
            if(!prepared.ok) throw new WriterSelectionError(`attempt_worktree_baseline_failed:${prepared.reason}`);
            dirtBefore=prepared.snapshots;
            if(!setAttemptWorkspace(db,input.attemptId,{path:workspacePath,environmentId:null,decision:workspaceDecision})) {
              throw new WriterSelectionError("attempt_workspace_cas_conflict");
            }
            // Where the attempt starts from, on record (SMA wall 4).
            deps.services.rollback?.noteBase(input.attemptId,created.baseSha);
            environment={type:"host",hostId:input.config.hostId,workspace:{type:"unmanaged",path:workspacePath}};
          } else {
            throw new WriterSelectionError(worktreeCreateError(created.reason));
          }
        }
      } else {
      try {
        requireManagedWorktreeProvider(await bb.sdk.environments.listProviders({
          projectId:input.projectId, hostId:input.config.hostId,
        }));
      } catch (cause) {
        throw new WriterSelectionError(cause instanceof Error ? cause.message : String(cause));
      }
      // Provision a managed worktree with a short-lived holder. Wait until the environment is
      // bound and ready, then stop the holder before the writer starts.
      let holderThreadId=getAttempt(db,input.attemptId)?.holder_thread_id ?? null;
      let spawnEnvironmentId:string|null=null;
      if(!holderThreadId) {
        const current=getAttempt(db,input.attemptId);
        if(!current) throw new WriterSelectionError("attempt_worktree_holder_missing_attempt");
        holderThreadId=await deps.services.recoverLostHolderThread(input.projectId, current);
      }
      if(!holderThreadId) {
        await bb.storage.kv.set(holderSpawnKey(input.attemptId),Date.now());
        const holder = await spawnWithSeam(() => fullAccessSpawn(bb, {
          projectId:input.projectId, ...execution,
          // The holder only answers «OK»: the workspace-provisioner profile (no plugins, skills, MCP or instructions).
          ...projectRoleField(bb, db, input.projectId, args.writerProviderId, "workspace-provisioner"),
          prompt:"Make no file changes and reply with the single word OK.",
          environment:{type:"host",hostId:input.config.hostId,workspace:{type:"managed-worktree",baseBranch:{kind:"default"}}},
          visibility:"hidden",pluginMetadata:{role:"workspace-provisioner",lanePilotRunId:input.runId,lanePilotTaskId:input.taskId,workspaceAttemptId:input.attemptId},
        }));
        holderThreadId=stringAt(holder,"id");
        spawnEnvironmentId=stringAt(holder,"environmentId");
        if(!holderThreadId) throw new WriterSelectionError("attempt_worktree_provision_missing_thread");
        const recorded=setAttemptHolderThread(db,input.attemptId,holderThreadId);
        if(recorded) await bestEffort(bb.log, "writer holder spawn key clear", bb.storage.kv.delete(holderSpawnKey(input.attemptId)), undefined);
        if(!recorded) {
          const persisted=getAttempt(db,input.attemptId)?.holder_thread_id;
          if(!persisted) throw new WriterSelectionError("attempt_worktree_holder_cas_conflict");
          if(persisted!==holderThreadId) {
            await bestEffort(bb.log, "writer holder thread stop", bb.sdk.threads.stop({threadId:holderThreadId}), undefined);
            holderThreadId=persisted;
            spawnEnvironmentId=null;
          }
        }
      }
      let environmentId:string;
      try {
        environmentId=(await waitManagedWorktreeReady({
          threadId:holderThreadId,
          expectedHostId:input.config.hostId,
          spawnEnvironmentId,
          getThread:(threadId)=>bb.sdk.threads.get({threadId}),
          getEnvironment:(id)=>bb.sdk.environments.get({environmentId:id}),
        })).environmentId;
      } catch (cause) {
        await bestEffort(bb.log, "writer holder thread stop", bb.sdk.threads.stop({threadId:holderThreadId}), undefined);
        throw new WriterSelectionError(cause instanceof Error ? cause.message : String(cause));
      }
      await bb.sdk.threads.stop({threadId:holderThreadId});
      const holderState=await bb.sdk.threads.get({threadId:holderThreadId});
      const holderStatus=stringAt(holderState,"status");
      if(holderStatus!=="idle"&&holderStatus!=="error") throw new WriterSelectionError(`attempt_worktree_provisioner_not_stopped:${holderStatus??"unknown"}`);
      const managed=resolveManagedWorkspace(await bb.sdk.environments.get({environmentId}),input.config.hostId);
      workspacePath=managed.path;
      // Linking dependencies helps the writer's checks; a host without it still gets a clean worktree.
      await bestEffort(bb.log, "writer worktree prepare", host.call("gitPrepareWorktree",{requestedHostId:input.config.hostId,basePath:base,worktreePath:workspacePath,
        ownsBarrier,ownsPaths:input.task.owns_paths,neverTouch:input.task.never_touch},
        {hostId:input.config.hostId,timeoutMs:600_000}), undefined);
      const prepared=await workspaceDirt(input.config,workspacePath,input.runId);
      if(!prepared.ok) throw new WriterSelectionError(`attempt_worktree_baseline_failed:${prepared.reason}`);
      if(prepared.snapshots.length) throw new WriterSelectionError(`attempt_worktree_not_clean:${prepared.snapshots.map(row=>row.path).join(",")}`);
      dirtBefore=prepared.snapshots;
      if(!setAttemptWorkspace(db,input.attemptId,{path:workspacePath,environmentId:managed.environmentId,decision:workspaceDecision})) {
        throw new WriterSelectionError("attempt_workspace_cas_conflict");
      }
      environment={type:"reuse",environmentId:managed.environmentId};
      }
    } else if (!setAttemptWorkspace(db,input.attemptId,{path:workspacePath,environmentId:nestedBase ? null : run.writer_environment_id,decision:workspaceDecision})) {
      throw new WriterSelectionError("attempt_workspace_cas_conflict");
    }
    return { workspacePath, environment, providerEnvironment, dirtBefore };
  }

  return { prepareProviderWorktree, launchOnProvider, nestedInRepo, workspaceDirt, bindAttemptWorkspace };
}

