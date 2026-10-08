import { compiledMainAgentSpawnBinding, detectCompiledMainAgentCapability, resolveSelectedMainAgentProfile } from "../agent-profile";
import type { CompiledMainAgent } from "../agent-profile";
import { readyComposerSnapshot, spawnEnvironmentFromSelection } from "../composer-selection";
import type { ComposerSelectionSnapshot } from "../composer-selection";
import { TARGET_SHA } from "../constants";
import { claimActivation, createRun, freezeRunBinding, getActivation, getRunSettingsScopes, importSettingsOnce, loadPrototypeConfig, releaseActivation, setRunState, setRunThread, setRunWorkspace } from "../database";
import { ownerCardBlock } from "../rooms/anamnesis/card";
import { anamnesisFor } from "../rooms/anamnesis/wiring";
import { pmRulesPromptBlock } from "../rooms/learning/pm-rules";
import { ruleBudget } from "../rooms/learning/rule-budget";
import { writerExecutionSelection } from "@lane-pilot/models";
import { buildRunPolicy } from "../rooms/tasks/run-policy";
import { parseWorkspaceMode, resolveManagedWorkspace, usesManagedWorktree } from "../rooms/verification/routing";
import { excludeBookkeeping } from "../rooms/verification/server/bookkeeping-exclude";
import { fullAccessSpawn, pmHasGuard, pmPrompt } from "./pm-spawn";
import { requireHelperSpawn, requiredPolicyField } from "./run-routing";
import { id, stringAt, valueAt } from "./values";
import type { ServerCore } from "./core";
import type { Services } from "./services";

export function createActivation(ctx: ServerCore, services: Services) {
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
      ? await bb.sdk.projects.get({ projectId }).catch(() => null) as { sources?: Array<{ hostId?: string; path?: string }> } | null
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
      const listed = await bb.sdk.environments.listProviders({ projectId, ...(hostId ? { hostId } : {}) }).catch(() => null);
      if (Array.isArray(listed) && !listed.some((row) => stringAt(row, "id") === env.environmentProviderId || stringAt(row, "environmentProviderId") === env.environmentProviderId)) {
        throw new Error(`composer_environment_provider_unknown:${env.environmentProviderId}`);
      }
    }
  }

  async function activate(projectId: string, sourceThreadId: string | null, kind: "bb"|"cli" = "bb", agentId?: string | null, snapshot?: ComposerSelectionSnapshot): Promise<{threadId:string; runId:string}> {
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
    if (!native) {
      const detected = await host.call("detect", {
        requestedHostId: config.hostId,
        workspacePath: config.pmWorkspacePath,
      }, { hostId: config.hostId, timeoutMs: 30_000 });
      if (!detected.workspace.present) {
        throw new Error(`Lane Pilot PM workspace is missing: ${detected.workspace.path}`);
      }
      const inventory = await host.call("coexistenceInventory", {
        requestedHostId:config.hostId, projectId, targetSha:TARGET_SHA,
      }, { hostId:config.hostId, timeoutMs:30_000 });
      const compatibleEngine = inventory.managers.find((manager) =>
        ["agents-marker", "managed-checkout", "claude-cache"].includes(manager.manager) && manager.compatible === true,
      );
      if (!compatibleEngine) {
        const missing = [...new Set(inventory.managers.flatMap((manager) => manager.missingCapabilities))];
        const detail = missing.length ? `Missing required interfaces: ${missing.join(", ")}.` : "No installed engine exposed a probeable set of required interfaces.";
        throw new Error(`Lane Pilot PM cannot activate: no compatible engine was found. ${detail} Reference version ${TARGET_SHA} is provenance only; SHA/version mismatch does not decide compatibility.`);
      }
      const imported = await host.call("importConfig", {
        requestedHostId: config.hostId,
        workspacePath: config.pmWorkspacePath,
        projectId,
      }, { hostId: config.hostId, timeoutMs: 30_000 });
      importSettingsOnce(db, projectId, imported.imported);
    }
    const existing = getActivation(db, projectId);
    if (existing) refreshRun(existing.run_id);
    const settings = { ...(await effectiveProjectSettings(projectId)).values };
    if (agentId !== undefined && agentId !== null) {
      if (agentId === "") delete settings["main.agent"];
      else settings["main.agent"] = agentId;
    }
    const owned = await ownedAgents();
    compiledMainAgentSpawnBinding({
      capability: detectCompiledMainAgentCapability(
        (bb as { agents?: { experimental_vkCompiledMainAgent?: unknown } }).agents ?? {},
      ),
      profile: (() => {
        const profile = resolveSelectedMainAgentProfile(settings, owned);
        return profile ? Object.freeze(JSON.parse(JSON.stringify(profile)) as CompiledMainAgent) : null;
      })(),
    });
    const configuredRunGate = settings["run.gate"];
    if (configuredRunGate !== undefined && configuredRunGate !== "none" && configuredRunGate !== "pre-merge") {
      throw new Error(`invalid run.gate setting: ${String(configuredRunGate)}`);
    }
    const runGate = configuredRunGate === "pre-merge" ? "pre-merge" : "none";
    const workspaceMode = parseWorkspaceMode(settings["adoc.040"]);
    const managedWorkspace = usesManagedWorktree(workspaceMode);
    const snapshotEnv = native ? spawnEnvironmentFromSelection(native) : null;
    const runHostId = native ? null : config.hostId;
    const runWorkspacePath = native ? null : (managedWorkspace ? null : config.writerWorkspacePath);
    const runId = id("lprun");
    createRun(db, runId, projectId, kind, runWorkspacePath, runGate, buildRunPolicy(settings), runHostId);
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
    const spawnTier = native?.serviceTier === "fast" ? "fast" as const : native?.serviceTier === "default" ? "default" as const : null;
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
          : { providerId: spawnProviderId, model: spawnModel, executionInputSources:{ providerId:"explicit" as const, model:"explicit" as const } }),
        // The owner's confirmed, non-sensitive facts (anamnesis A5), within 1800 characters; nothing when there are none or the store is out of reach.
        prompt: pmPrompt(runId, config, !native && managedWorkspace, Boolean(native), pmHasGuard(settings["main.agent"])) + await ownerCardBlock(anamnesisFor(ctx).hub)
          // The rules the owner's corrections produced for the PM, within a token budget (src/learning/pm-rules.ts).
          + pmRulesPromptBlock(db, projectId, getRunSettingsScopes(db, runId), ruleBudget("pm")),
        environment: (snapshotEnv ?? (managedWorkspace
          ? { type:"host", hostId:config.hostId, workspace:{ type:"managed-worktree", baseBranch:{ kind:"default" } } }
          : { type:"host", hostId:config.hostId, workspace:{ type:"unmanaged", path:config.pmWorkspacePath } })) as never,
        visibility:"visible",
        pluginMetadata:{ role:"pm", lanePilotRunId:runId },
        ...compiledMainAgentSpawnBinding({
          capability: detectCompiledMainAgentCapability(
            (bb as { agents?: { experimental_vkCompiledMainAgent?: unknown } }).agents ?? {},
          ),
          profile: (() => {
            const profile = resolveSelectedMainAgentProfile(settings, owned);
            return profile ? Object.freeze(JSON.parse(JSON.stringify(profile)) as CompiledMainAgent) : null;
          })(),
        }),
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
    let checkout:{ hostId:string; path:string } | null = bindResolvedEnvironment ? null : { hostId:config.hostId, path:config.writerWorkspacePath };
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
          if (!setRunWorkspace(db, runId, workspace.path, workspace.environmentId ?? environmentId)) {
            throw new Error("managed workspace CAS failed; run is no longer pending or already has a workspace binding");
          }
          checkout = { hostId, path:workspace.path };
        }
      } catch (cause) {
        setRunState(db, runId, "blocked");
        releaseActivation(db, projectId, runId);
        await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
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

  return { assertComposerEnvironment, activate };
}
