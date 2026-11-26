import { compiledMainAgentSpawnBinding, detectCompiledMainAgentCapability, resolveSelectedMainAgentProfile, type CompiledMainAgent } from "../../models/agent-profile";
import { readyComposerSnapshot, spawnEnvironmentFromSelection } from "../../../contracts/composer-selection";
import type { ComposerSelectionSnapshot } from "../../../contracts/composer-selection";
import { claimActivation, createRun, freezeRunBinding, getActivation, loadPrototypeConfig, releaseActivation, setRunState, setRunThread } from "../../../storage";
import { writerExecutionSelection } from "@lane-pilot/models";
import { buildRunPolicy } from "../../../tasks";
import { parseWorkspaceMode, resolveManagedWorkspace, usesManagedWorktree } from "../../../verification";
import { excludeBookkeeping } from "../../../verification/server";
import { fullAccessSpawn, pmPrompt, type WriterHostApi } from "../../../platform/server";
import { requireHelperSpawn, requiredPolicyField } from "../../../runs/server";
import { id, stringAt, valueAt, orMiss, isNotFound, bestEffort } from "@lane-pilot/kit";
import { isLanePmAgent, type ServerCore } from "../../../contracts/server";

import type { ResumeOrphansPort } from "../../../contracts/stability-api";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  resumeOrphans: ResumeOrphansPort["resumeOrphans"];
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
}


export function createActivation(
  ctx: ServerCore,
  services: Services,
) {
  const { bb, db, effectiveProjectSettings, host, ownedAgents, refreshRun } = ctx;

  async function assertComposerEnvironment(projectId: string, snapshot: Extract<ComposerSelectionSnapshot, { status: "ready" }>): Promise<void> {
    const env = snapshot.environment;
    if (env.kind === "existing" && env.type === "project-default") {
      throw new Error("composer_environment_project_default_unsupported");
    }
    if (env.kind === "existing" && env.type === "reuse") {
      const row = await bb.sdk.environments.get({ environmentId: env.environmentId });
      if (!row) throw new Error("composer_environment_missing");
      const envProject = stringAt(row, "projectId");
      if (envProject && envProject !== projectId) throw new Error("composer_environment_project_mismatch");
      const envHost = stringAt(row, "hostId");
      if (env.hostId && envHost && env.hostId !== envHost) throw new Error("composer_environment_host_mismatch");
      const envPath = stringAt(row, "path");
      if (env.path && envPath && env.path !== envPath) throw new Error("composer_environment_path_mismatch");
      return;
    }
    const project = typeof bb.sdk.projects?.get === "function"
      ? await orMiss(bb.sdk.projects.get({ projectId }), null, isNotFound) as { sources?: Array<{ hostId?: string; path?: string }> } | null
      : null;
    const sources = Array.isArray(project?.sources) ? project.sources : [];
    if (env.kind === "existing" && env.type === "host") {
      if (!env.hostId) throw new Error("composer_environment_host_missing");
      if (sources.length && !sources.some((row) => row.hostId === env.hostId && (!env.path || !row.path || row.path === env.path))) {
        throw new Error("composer_environment_host_not_in_project");
      }
      return;
    }
    if (env.kind === "provisioning" && env.type === "provider") {
      const hostId = env.machine?.type === "existing" ? env.machine.hostId : undefined;
      if (hostId && sources.length && !sources.some((row) => row.hostId === hostId)) {
        throw new Error("composer_environment_host_not_in_project");
      }
      const listed = await bb.sdk.environments.listProviders({ projectId, ...(hostId ? { hostId } : {}) });
      if (Array.isArray(listed) && !listed.some((row) => stringAt(row, "id") === env.environmentProviderId || stringAt(row, "environmentProviderId") === env.environmentProviderId)) {
        throw new Error(`composer_environment_provider_unknown:${env.environmentProviderId}`);
      }
    }
  }

  async function activate(projectId: string, sourceThreadId: string | null, kind: "bb"|"cli" = "bb", agentId?: string | null, snapshot?: ComposerSelectionSnapshot, options?: { sectionId?: string | null }): Promise<{threadId:string; runId:string}> {
    if (sourceThreadId) {
      const sourceMetadata = await bb.sdk.threads.getPluginMetadata({ threadId:sourceThreadId });
      if (valueAt(sourceMetadata, "role") === "writer") {
        throw new Error("Lane Pilot writer threads cannot activate a PM");
      }
    }
    const config = loadPrototypeConfig(db, projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${projectId}`);
    const native = snapshot ? readyComposerSnapshot(snapshot, projectId) : null;
    if (native) await assertComposerEnvironment(projectId, native);
    // Legacy activation has no composer snapshot to carry an authoritative writer environment. Resolve the
    // project source before creating a run so an obsolete prototype writerWorkspacePath cannot contaminate
    // the run, PM instructions, or bookkeeping. The PM's own workspace remains the explicit configured path.
    const writerBinding = native ? null : await services.resolveProjectWriterHost({ projectId, threadId: sourceThreadId });
    if (writerBinding && writerBinding.status !== "resolved") {
      switch (writerBinding.status) {
        case "ambiguous":
          throw new Error("Lane Pilot writer binding is ambiguous; select a project folder before activating");
        case "offline":
          throw new Error(`Lane Pilot writer host is offline: ${writerBinding.hostId}`);
        case "catalog_unavailable":
          throw new Error(`Lane Pilot writer binding is unavailable: ${writerBinding.reason}`);
        case "setup_required":
          throw new Error("Lane Pilot writer binding is not configured; add a project folder before activating");
      }
    }
    if (!native) {
      const detected = await host.call("detect", {
        requestedHostId: config.hostId,
        workspacePath: config.pmWorkspacePath,
      }, { hostId: config.hostId, timeoutMs: 30_000 });
      if (!detected.workspace.present) {
        throw new Error(`Lane Pilot PM workspace is missing: ${detected.workspace.path}`);
      }
      // No Claude Lane engine is required any more: Lane Pilot starts its agents and guard itself (2026-10-29), and the cleanup moved
      // the engine aside. The gate stopped every activation outside the composer (drill parallel3, 2026-10-30).
    }
    const existing = getActivation(db, projectId);
    if (existing) refreshRun(existing.run_id);
    const settings = { ...(await effectiveProjectSettings(projectId)).values };
    if (agentId !== undefined && agentId !== null) {
      if (agentId === "") delete settings["main.agent"];
      else settings["main.agent"] = agentId;
    }
    const owned = await ownedAgents();
    // Built before createRun so an unsupported profile fails before the run row exists.
    const selectedProfile = resolveSelectedMainAgentProfile(settings, owned);
    if (selectedProfile && isLanePmAgent(selectedProfile.id)) {
      bb.log.debug(`pm prompt chars=${selectedProfile.prompt.length} tools=${selectedProfile.tools?.length ?? 0}`);
    }
    const mainAgentBinding = compiledMainAgentSpawnBinding({
      capability: detectCompiledMainAgentCapability(
        (bb as { agents?: { experimental_vkCompiledMainAgent?: unknown } }).agents ?? {},
      ),
      profile: selectedProfile ? Object.freeze(JSON.parse(JSON.stringify(selectedProfile)) as CompiledMainAgent) : null,
    });
    const configuredRunGate = settings["run.gate"];
    if (configuredRunGate !== undefined && configuredRunGate !== "none" && configuredRunGate !== "pre-merge") {
      throw new Error(`invalid run.gate setting: ${String(configuredRunGate)}`);
    }
    const runGate = configuredRunGate === "pre-merge" ? "pre-merge" : "none";
    const workspaceMode = parseWorkspaceMode(settings["adoc.040"]);
    const managedWorkspace = usesManagedWorktree(workspaceMode);
    const snapshotEnv = native ? spawnEnvironmentFromSelection(native) : null;
    const writerConfig = writerBinding ? { ...config, hostId: writerBinding.hostId, writerWorkspacePath: writerBinding.path } : config;
    // A managed legacy PM is provisioned on the explicit PM host; its actual environment binding below
    // supplies the run host. Leave it unset until then so a writer source on another host cannot leak into
    // the managed checkout's host bookkeeping.
    const runHostId = native || managedWorkspace ? null : writerBinding?.hostId ?? null;
    const runWorkspacePath = native ? null : (managedWorkspace ? null : writerBinding?.path ?? null);
    const runId = id("lprun");
    createRun(db, runId, projectId, kind, runWorkspacePath, runGate, buildRunPolicy(settings, (line) => bb.log.warn(line)), runHostId);
    claimActivation(db, { projectId, pmThreadId:`pending:${sourceThreadId ?? "new"}`, runId });
    let lifecycleOwnerThreadId = sourceThreadId ?? undefined;
    if (sourceThreadId) {
      try {
        lifecycleOwnerThreadId = stringAt(await bb.sdk.threads.get({ threadId: sourceThreadId }), "lifecycleOwnerThreadId") || sourceThreadId;
      } catch {
        lifecycleOwnerThreadId = sourceThreadId;
      }
    }
    const spawnProviderId = native?.providerId ?? config.pmProviderId;
    const spawnModel = native?.model ?? config.pmModel;
    const spawnTier = native?.serviceTier === "fast" ? "fast" as const : "default" as const;
    let spawned:Awaited<ReturnType<typeof bb.sdk.threads.spawn>>;
    try {
      spawned = await fullAccessSpawn(bb, {
        projectId,
        // BB 0.5 accepts sourceThreadId only on forks (originKind); the PM is a child of the chat it was enabled from.
        ...(sourceThreadId ? {
          parentThreadId: sourceThreadId,
          ...(lifecycleOwnerThreadId ? { lifecycleOwnerThreadId } : {}),
        } : {}),
        ...(native
          ? writerExecutionSelection(spawnProviderId, spawnModel, native.reasoningLevel, spawnTier)
          : { providerId: spawnProviderId, model: spawnModel, serviceTier: spawnTier, executionInputSources:{ providerId:"explicit" as const, model:"explicit" as const, serviceTier:"explicit" as const } }),
        prompt: pmPrompt(runId, writerConfig, !native && managedWorkspace, Boolean(native)),
        environment: (snapshotEnv ?? (managedWorkspace
          ? { type:"host", hostId:config.hostId, workspace:{ type:"managed-worktree", baseBranch:{ kind:"default" } } }
          : { type:"host", hostId:config.hostId, workspace:{ type:"unmanaged", path:config.pmWorkspacePath } })) as never,
        visibility:"visible",
        // A PM chat opened for another project's handoff lands in the section the caller named.
        ...(options?.sectionId ? { sectionId: options.sectionId } : {}),
        pluginMetadata:{ role:"pm", lanePilotRunId:runId },
        ...mainAgentBinding,
        ...requiredPolicyField(bb, requireHelperSpawn({ bb, db, projectId, runId }), spawnProviderId),
      });
    } catch (cause) {
      setRunState(db, runId, "blocked");
      releaseActivation(db, projectId, runId);
      throw cause;
    }
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("threads.spawn returned no PM thread id");
    const bindResolvedEnvironment = native || managedWorkspace;
    // Where the project's checkout is on its machine: bookkeeping paths are excluded there once the binding is known.
    let checkout:{ hostId:string; path:string } | null = bindResolvedEnvironment ? null : writerBinding;
    if (bindResolvedEnvironment) {
      const environmentId = stringAt(spawned, "environmentId");
      try {
        if (!environmentId) throw new Error("spawn returned no environmentId");
        const environment = await bb.sdk.environments.get({ environmentId });
        if (native) {
          const hostId = stringAt(environment, "hostId");
          const path = stringAt(environment, "path");
          if (!hostId || !path) throw new Error("spawned environment missing host or path");
          if (!freezeRunBinding(db, runId, { hostId, workspacePath: path, environmentId })) {
            throw new Error("native environment CAS failed; run is no longer pending or already has a binding");
          }
          checkout = { hostId, path };
        } else {
          const hostId = stringAt(environment, "hostId") ?? config.hostId;
          const workspace = resolveManagedWorkspace(environment, hostId);
          if (!workspace.path) throw new Error("managed workspace missing path");
          if (!freezeRunBinding(db, runId, { hostId, workspacePath: workspace.path, environmentId: workspace.environmentId ?? environmentId })) {
            throw new Error("managed workspace CAS failed; run is no longer pending or already has a workspace binding");
          }
          checkout = { hostId, path:workspace.path };
        }
      } catch (cause) {
        setRunState(db, runId, "blocked");
        releaseActivation(db, projectId, runId);
        await bestEffort(bb.log, "activation cleanup thread stop", bb.sdk.threads.stop({ threadId }), undefined);
        throw new Error(`Lane Pilot failed closed while binding environment: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    setRunThread(db, runId, threadId);
    claimActivation(db, { projectId, pmThreadId:threadId, runId });
    // Bookkeeping folders that do not belong in history go to the repository's .git/info/exclude (no commit, no .gitignore edit).
    const excluded = checkout
      ? await excludeBookkeeping((input) => host.call("runCommand", input, { hostId:input.requestedHostId, timeoutMs:30_000 }), checkout.hostId, checkout.path, ctx.log)
      : [];
    await services.resumeOrphans(projectId);
    return { threadId, runId, ...(excluded.length ? { bookkeepingExcluded:excluded } : {}) };
  }

  return { activate };
}

export type ActivationApi = ReturnType<typeof createActivation>;
