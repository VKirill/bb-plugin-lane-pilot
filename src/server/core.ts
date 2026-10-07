import { parseOwnedAgents } from "../agent-profile";
import { bindDrainTarget, createDeployDrain } from "./deploy-drain";
import { createHostJobs, isHostJobKind } from "./host-jobs";
import { aggregateRun } from "../aggregation";
import { TARGET_SHA } from "../constants";
import { hostContract } from "../contracts";
import type { PrototypeConfig, TaskV2 } from "../contracts";
import { getAttempt, getRun, getRunSettingsScopes, getRunWriterHost, getTask, getTaskPlan, listAttemptsForTask, listStageReceipts, listTaskTerminalStates, loadProjectSettings, loadPrototypeConfig, sectionBindingId, setRunSettingsScopes, setRunState, transitionAttempt } from "../database";
import { writerServiceTier } from "../jev-reasoning";
import { GLOBAL_SETTINGS_PROJECT_ID, LP_AGENT_OVERRIDES_KEY, LP_DEFAULTS_KEY, inheritProjectValues, parseLanePilotDefaults } from "../lp-defaults";
import { createNativeInstaller } from "../native-install-lifecycle";
import type { WriterBindingResolution } from "../project-binding";
import { parseRunPolicy } from "../stages/run-policy";
import type { AttemptState } from "../state-machine";
import { cancelRejection } from "./run-finish";
import { recordStage } from "./stage-records";
import { stringAt, valueAt } from "./values";
import { resolve } from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LanePilotDatabase } from "../database";

/** Everything every server module shares: the SDK, storage, the host client and the small helpers used across modules. */
export function createCore(bb: BbPluginApi, db: LanePilotDatabase) {
  // Set before the database closes on reload (dispose hooks run LIFO); detached writer tasks check it.
  const state = { disposed: false };
  bb.onDispose(() => { state.disposed = true; });

  const rawHost = bb.hosts.experimental_client({ contract:hostContract });

  // Jev's key lives in BB's Env Catalog (TYPESAFE_API_KEY); the server reads it there and sends it with each Jev
  // call, so machines need no ~/secrets/typesafe.env. Without Env Catalog or the record a machine falls back to its own.
  const JEV_METHODS = new Set(["classifyPlan","councilJudge","docsAnchors","docsFlows","docsDepth","docsVerifyCitations","docsStaleness"]);
  let jevKeyCache: { value: string | undefined; at: number } | null = null;
  async function catalogJevKey(): Promise<string | undefined> {
    if (jevKeyCache && Date.now() - jevKeyCache.at < 10 * 60_000) return jevKeyCache.value;
    const plugins = (bb.sdk as { plugins?: { callRpc?: (args:{pluginId:string;method:string;input?:unknown;outputSchema:z.ZodType<unknown>}) => Promise<unknown> } }).plugins;
    let value: string | undefined;
    try {
      const record = await plugins?.callRpc?.({ pluginId:"env-catalog", method:"env_get_value", input:{ name:"TYPESAFE_API_KEY" },
        outputSchema:z.object({ value:z.string().nullable() }).passthrough() }) as { value:string | null } | undefined;
      value = record?.value?.trim() || undefined;
    } catch { value = undefined; }
    if (Boolean(value) !== Boolean(jevKeyCache?.value)) {
      bb.log.info(value ? "jev key: from Env Catalog (TYPESAFE_API_KEY)" : "jev key: not in Env Catalog, machines use their own");
    }
    jevKeyCache = { value, at: Date.now() };
    return value;
  }
  const deployDrain = createDeployDrain(() => state.disposed);
  bindDrainTarget({ drain: deployDrain, log: (line) => bb.log.info(line) });
  const rawCall = rawHost.call as (method: string, input: unknown, options: unknown) => Promise<unknown>;
  // Long host calls run as background jobs (B4): the host daemon cancels a call at its deadline and kills the worker.
  const hostJobs = createHostJobs({
    call: rawCall, kv: bb.storage.kv, disposed: () => state.disposed, log: (message) => bb.log.info(message),
  });
  const host = {
    ...rawHost,
    call: (async (method: string, input: unknown, options: unknown) => await deployDrain.around(method, async () => {
      // `job: true` asks for a background job where it is not the rule (the post-merge check); the host never sees it.
      // `jobKey` names the one logical call a job answers (an attempt's post-merge check of one merge commit): a finished job
      // is taken again only under the same key, never by another call with the same input.
      const { job, jobKey, ...hostOptions } = (options ?? {}) as { hostId: string; timeoutMs?: number; job?: boolean; jobKey?: string };
      const direct = async () => {
        const key = JEV_METHODS.has(method) ? await catalogJevKey() : undefined;
        return await rawCall(method, key ? { ...(input as Record<string, unknown>), jevApiKey:key } : input, hostOptions);
      };
      // LANE_PILOT_HOST_JOBS=0 runs every call directly, as before jobs: a switch for a host where they misbehave.
      if (process.env.LANE_PILOT_HOST_JOBS !== "0" && isHostJobKind(method) && (method !== "runSandboxedCommand" || job === true)) return await hostJobs.run(method, input, hostOptions, direct, jobKey);
      return await direct();
    })) as typeof rawHost.call,
  } as typeof rawHost;


  const nativeInstaller = createNativeInstaller({
    supported: (bb.server as unknown as { experimental_vkPluginLifecycle?: boolean }).experimental_vkPluginLifecycle === true,
    kv: bb.storage.kv,
    call: (hostId, action) => host.call("nativeInstall", { requestedHostId: hostId, action }, { hostId, timeoutMs: 600_000 }),
    log: (message) => bb.log.warn(message),
  });

  const nativeHost = {
    async call(method: string, input: unknown, options: { hostId: string }) {
      if (method === "prepareNativeClaude") await nativeInstaller.ensure(options.hostId);
      return (host.call as (method: string, input: unknown, options: { hostId: string }) => Promise<unknown>)(method, input, options);
    },
  };

  let kvChain = Promise.resolve();

  function serializedKv<T>(work: () => Promise<T>): Promise<T> {
    const next = kvChain.then(work, work);
    kvChain = next.then(() => undefined, () => undefined);
    return next;
  }

  async function ownedAgents() {
    return parseOwnedAgents(await bb.storage.kv.get(LP_AGENT_OVERRIDES_KEY));
  }

  async function effectiveProjectSettings(projectId: string, scopes: readonly string[] = []) {
    return inheritProjectValues(
      loadProjectSettings(db, projectId, scopes),
      parseLanePilotDefaults(await bb.storage.kv.get(LP_DEFAULTS_KEY)),
    );
  }

  function screenWriterBinding(binding: WriterBindingResolution | { status: "catalog_unavailable"; reason: string }): {
    status: WriterBindingResolution["status"] | "catalog_unavailable";
    hostId: string | null;
    path: string | null;
    source: "session" | "unique_source" | "explicit_override" | null;
    bindings: Array<{ id?: string; hostId: string; path: string; isDefault?: boolean }>;
  } {
    if (binding.status === "catalog_unavailable") {
      return { status: "catalog_unavailable", hostId: null, path: null, source: null, bindings: [] };
    }
    const status: WriterBindingResolution["status"] = binding.status;
    return {
      status,
      hostId: binding.status === "resolved" || binding.status === "offline" ? binding.hostId : null,
      path: binding.status === "resolved" || binding.status === "offline" ? binding.path : null,
      source: binding.status === "resolved" ? binding.source : null,
      bindings: binding.status === "ambiguous"
        ? binding.bindings.map((row) => ({ id: row.id, hostId: row.hostId, path: row.path, isDefault: row.isDefault }))
        : [],
    };
  }

  async function coexistenceInventory(projectId:string, hostId:string) {
    return await host.call("coexistenceInventory", { requestedHostId:hostId, projectId, targetSha:TARGET_SHA }, { hostId, timeoutMs:30_000 });
  }

  async function coexistenceOperation(input:{projectId:string;hostId:string;operation:"install"|"connect"|"update"|"reload"|"disconnect"|"rollback";manager:"agents-marker"|"managed-checkout"|"claude-cache"|"claude-settings"|"opencode-config"|"opencode-plugin";path:string;expectedSha256?:string|null;snapshotId?:string|null;targetSha?:string|null}) {
    const { hostId, ...operation } = input;
    return await host.call("coexistenceOperation", { requestedHostId:hostId, ...operation }, { hostId, timeoutMs:600_000 });
  }

  async function getThreadBounded(threadId:string, timeoutMs = 2_000): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return await Promise.race([
      bb.sdk.threads.get({ threadId }).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  function acceptedTaskWorkspace(runId:string, taskId:string, runWorkspacePath:string, contractTask:TaskV2, attemptId?:string):{
    task:TaskV2; path:string; environmentId:string|null;
  } {
    if (contractTask.project_cwd !== runWorkspacePath) throw new Error("task contract no longer matches the immutable run workspace");
    const selected=attemptId?getAttempt(db,attemptId):null;
    if(attemptId&&(!selected||selected.run_id!==runId||selected.task_id!==taskId)) throw new Error("attempt workspace binding does not belong to this task");
    const acceptedId=attemptId?null:[...listAttemptsForTask(db,runId,taskId)].reverse().find((attempt)=>attempt.state==="accepted")?.id;
    const binding=selected??(acceptedId?getAttempt(db,acceptedId):null);
    // Lane Pilot's own attempt worktree (native run, no BB environment) is gone once merged or failed:
    // accepted work is in the run workspace, and a retry gets a fresh worktree. An attempt still in flight
    // keeps its worktree: resumed after a reload it was checked against the base checkout and failed with
    // «ownership run scope invalid» (SelfyStudio, 2026-10-02).
    const inFlight=["queued","spawn_requested","spawn_unknown","running","cancel_requested"].includes(String(binding?.state));
    const ownWorktree=getRun(db,runId)?.kind==="cli"&&binding?.environment_id===null&&!(selected&&inFlight);
    // An accepted attempt's work is merged into the run workspace; its BB worktree may stay for the area's next task,
    // and a stage writing there (PROGRESS.md after acceptance) slipped into that task's merge (SelfyStudio 2026-10-05).
    // A caller naming the attempt (workspace status, reconcile) still gets that attempt's own worktree.
    const merged=!attemptId&&binding?.state==="accepted"&&Boolean(binding.workspace_path)&&binding.workspace_path!==runWorkspacePath;
    const path=ownWorktree||merged?runWorkspacePath:(binding?.workspace_path??runWorkspacePath);
    return {path,environmentId:merged?getRun(db,runId)?.writer_environment_id??null:binding?.environment_id??null,
      task:{...contractTask,project_cwd:path,verification:contractTask.verification.map((command)=>({...command,cwd:path}))}};
  }

  function workspaceExecutionEnvironment(hostId:string, workspace:{path:string;environmentId:string|null}) {
    return workspace.environmentId
      ? {type:"reuse" as const,environmentId:workspace.environmentId}
      : {type:"host" as const,hostId,workspace:{type:"unmanaged" as const,path:workspace.path}};
  }

  function refreshRun(runId: string): void {
    const states = listTaskTerminalStates(db, runId) as AttemptState[];
    if (states.length === 0) {
      const run = getRun(db, runId);
      if (run?.state === "pending") setRunState(db, runId, "blocked");
      return;
    }
    setRunState(db, runId, aggregateRun(states));
  }

  function markCanceledWriterStages(attempt:NonNullable<ReturnType<typeof getAttempt>>,reason:string):void {
    const task=getTask(db,attempt.task_id);
    const plan=getTaskPlan(db,attempt.task_id)??(task?.kind==="bb"?valueAt(task.contract,"objective"):"") as string;
    for(const stageId of ["writer-agent","verification","acceptance-receipt"] as const){
      const current=listStageReceipts(db,attempt.run_id,attempt.task_id).find((row)=>row.stageId===stageId);
      if(current&&(current.state==="pending"||current.state==="running"))recordStage(db,{runId:attempt.run_id,taskId:attempt.task_id,
        stageId,state:"canceled",input:plan,attempt:attempt.attempt_no,threadId:attempt.thread_id,reason});
    }
  }

  function cancelQueuedAttempt(attempt: NonNullable<ReturnType<typeof getAttempt>>): {ok:boolean;state:string;reason:string|null} {
    const rejection=cancelRejection(db,attempt);
    if(rejection)return {ok:false,state:attempt.state,reason:rejection};
    // Its writer is being started: mark it, and the spawn stops the thread it gets (an owner's stop must hold).
    if((attempt.state==="spawn_requested"||attempt.state==="spawn_unknown")&&!attempt.thread_id){
      transitionAttempt(db,attempt.id,"cancel_requested",{reason:"canceled while its writer was starting"});
      return {ok:true,state:"cancel_requested",reason:null};
    }
    if(attempt.state!=="queued"||attempt.thread_id)return {ok:false,state:attempt.state,reason:"attempt has no writer thread"};
    transitionAttempt(db,attempt.id,"canceled");
    markCanceledWriterStages(attempt,"writer attempt canceled while waiting for provider pool");
    refreshRun(attempt.run_id);
    return {ok:true,state:"canceled",reason:null};
  }

  function isRuntimeSettingKey(key: string): boolean {
    if (key === "ui.language") return false;
    if (([
      "hostId", "pmWorkspacePath", "writerWorkspacePath", "pmProviderId",
      "pmModel", "writerProviderId", "writerModel",
    ] as const).includes(key as "hostId")) return false;
    return !key.startsWith("import.")
      && !key.startsWith("install.last")
      && !key.startsWith("writer.last")
      && !key.startsWith("cli.last");
  }

  async function cliSettingsFor(projectId: string, config: PrototypeConfig): Promise<Record<string, unknown>> {
    const stored = (await effectiveProjectSettings(projectId)).values;
    const settings: Record<string, unknown> = {
      "writer.provider": stored["writer.provider"] ?? config.writerProviderId,
      "writer.model": stored["writer.model"] ?? config.writerModel,
      "writer.reasoning_effort": stored["writer.reasoning_effort"] ?? "medium",
      "writer.service_tier": writerServiceTier(stored),
      "writer.fast_mode": stored["writer.fast_mode"],
      "jev.LANE_JEV_EFFORT": stored["jev.LANE_JEV_EFFORT"] ?? true,
      "jev.LANE_OPENCODE_JEV": stored["jev.LANE_OPENCODE_JEV"] ?? true,
      "ops.max_tasks": stored["ops.max_tasks"],
      "ops.poll_interval": stored["ops.poll_interval"],
      "ops.heartbeat_interval": stored["ops.heartbeat_interval"],
      "ops.retry_backoff": stored["ops.retry_backoff"],
      "ops.run_dir": stored["ops.run_dir"],
      "ops.project_cwd": stored["ops.project_cwd"] ?? config.writerWorkspacePath,
      "plan_critique.enabled": stored["plan_critique.enabled"] ?? true,
      "plan_critique.mode": stored["plan_critique.mode"] ?? "gate",
      "plan_critique.provider": stored["plan_critique.provider"],
      "night_review.model": stored["night_review.model"],
    };
    for (const [key, value] of Object.entries(stored)) {
      if (!isRuntimeSettingKey(key)) continue;
      if (!(key in settings) || settings[key] === undefined) settings[key] = value;
    }
    return settings;
  }

  function runPolicyFor(runId:string) {
    const run=getRun(db,runId);
    if(!run)throw new Error(`run does not exist: ${runId}`);
    return parseRunPolicy(JSON.parse(run.run_policy_json) as unknown);
  }

  /** A native Lane chat needs no project setup: its run carries the writer host and workspace, and the writer model comes from project or global Lane Pilot settings. */
  async function nativeRunConfig(projectId:string, run:NonNullable<ReturnType<typeof getRun>>): Promise<PrototypeConfig|null> {
    const hostId = getRunWriterHost(db, run.id);
    const workspace = run.writer_workspace_path;
    if (!hostId || !workspace) return null;
    const settings = (await effectiveProjectSettings(projectId, getRunSettingsScopes(db, run.id))).values;
    const text = (key:string) => typeof settings[key] === "string" && settings[key] ? settings[key] as string : null;
    const writerProviderId = text("writer.provider"), writerModel = text("writer.model");
    if (!writerProviderId || !writerModel) throw new Error("Choose the writer provider and model in Lane Pilot settings (project or defaults) before delegating.");
    // The emergency writer is the PM's own selection: the model this Lane chat runs on.
    const pmExecution = run.pm_thread_id ? await bb.sdk.threads.defaultExecutionOptions({ threadId:run.pm_thread_id }).catch(() => null) : null;
    const pmProviderId = stringAt(pmExecution, "providerId"), pmModel = stringAt(pmExecution, "model");
    return { projectId, hostId, pmWorkspacePath:workspace, writerWorkspacePath:workspace,
      pmProviderId:pmProviderId && pmModel ? pmProviderId : writerProviderId, pmModel:pmProviderId && pmModel ? pmModel : writerModel,
      writerProviderId, writerModel };
  }

  const sectionRowSchema = z.object({ id:z.string(), projectId:z.string(), parentId:z.string().nullable(), name:z.string(), path:z.string(), hostId:z.string(), kind:z.enum(["folder","group"]) });

  /** Sections come from Project Folders; without it a project simply has none. */
  async function listProjectSections(projectId:string): Promise<Array<z.infer<typeof sectionRowSchema>>> {
    const plugins = (bb.sdk as { plugins?: { callRpc?: (args:{pluginId:string;method:string;input?:unknown;outputSchema:z.ZodType<unknown>}) => Promise<unknown> } }).plugins;
    if (!plugins?.callRpc) return [];
    try {
      const listed = await plugins.callRpc({ pluginId:"project-folders", method:"sections_list", input:{ projectId },
        outputSchema:z.object({ sections:z.array(sectionRowSchema) }) }) as { sections:Array<z.infer<typeof sectionRowSchema>> };
      return listed.sections;
    } catch { return []; }
  }

  /** Settings scopes of a section, outermost first: its ancestors, then the section itself. */
  function sectionChain(sections:Array<z.infer<typeof sectionRowSchema>>, sectionId:string): string[] {
    const byId = new Map(sections.map((row) => [row.id, row]));
    const chain:string[] = [];
    for (let current = byId.get(sectionId); current && !chain.includes(sectionBindingId(current.id)); current = current.parentId ? byId.get(current.parentId) : undefined) {
      chain.unshift(sectionBindingId(current.id));
    }
    return chain;
  }

  /** What a settings level inherits: a section its parents and project, a project the global level. */
  function settingsAbove(projectId:string, scopes:readonly string[]): Record<string, unknown> {
    if (scopes.length) return loadProjectSettings(db, projectId, scopes.slice(0, -1));
    return projectId === GLOBAL_SETTINGS_PROJECT_ID ? {} : loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID);
  }

  /** The deepest section whose folder holds this workspace decides a run's settings scopes. */
  async function scopesForWorkspace(projectId:string, workspacePath:string): Promise<string[]> {
    const sections = await listProjectSections(projectId);
    const target = resolve(workspacePath);
    const owner = sections
      .filter((row) => row.kind === "folder" && row.path && (target === resolve(row.path) || target.startsWith(`${resolve(row.path)}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return owner ? sectionChain(sections, owner.id) : [];
  }

  async function ensureRunScopes(runId:string): Promise<string[]> {
    const run = getRun(db, runId);
    if (!run || run.kind !== "cli" || !run.writer_workspace_path) return getRunSettingsScopes(db, runId);
    const scopes = await scopesForWorkspace(run.project_id, run.writer_workspace_path);
    setRunSettingsScopes(db, runId, scopes);
    return scopes;
  }

  /** A native run's host, workspace and writer come from its binding and current settings, never from a stale prototype config. */
  async function configForRun(projectId:string, run:ReturnType<typeof getRun>): Promise<PrototypeConfig|null> {
    return run?.kind === "cli" ? await nativeRunConfig(projectId, run) : loadPrototypeConfig(db, projectId);
  }

  const writerBindingKey = (projectId: string) => `writer-binding:${projectId}`;

  return { bb, db, state, isDisposed: () => state.disposed, log: (message: string) => bb.log.warn(message), host, deployDrain, nativeInstaller, nativeHost, serializedKv, ownedAgents, effectiveProjectSettings, screenWriterBinding, coexistenceInventory, coexistenceOperation, getThreadBounded, acceptedTaskWorkspace, workspaceExecutionEnvironment, refreshRun, markCanceledWriterStages, cancelQueuedAttempt, isRuntimeSettingKey, cliSettingsFor, runPolicyFor, nativeRunConfig, sectionRowSchema, listProjectSections, sectionChain, settingsAbove, scopesForWorkspace, ensureRunScopes, configForRun, writerBindingKey };
}

export type ServerCore = ReturnType<typeof createCore>;
