import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  hostContract,
  prototypeConfigSchema,
  rpcContract,
  taskV2Schema,
  type PrototypeConfig,
  type TaskV2,
} from "./src/contracts";
import { TARGET_SHA, cliReceiptAttemptKey, cliReceiptRunKey } from "./src/constants";
import { aggregateRun } from "./src/aggregation";
import { buildCliInvocation } from "./src/argv-builder";
import { requiredCliFlags } from "./src/cli-flags";
import { attemptProduced, classifyCliOutcome, parseDirtSnapshots, type DirtSnapshot } from "./src/cli-outcome";
import { classifyWriterOutput, type VerifyResult } from "./src/validate-output";
import { findUnownedChanges, validateOwnershipContract } from "./src/verification/ownership";
import { parseReadFirstHints, renderReadFirstInstructions } from "./src/stages/read-first";
import { acceptanceArtifactDir, buildAcceptanceV2, bbWriterReportMarkdown, validateAcceptanceV2 } from "./src/acceptance-v2";
import {
  claimActivation,
  countAttempts,
  createAttempt,
  createRun,
  closeRun,
  createTask,
  getActivation,
  getAttempt,
  getRun,
  getTask,
  getTaskPlan,
  saveTaskPlan,
  saveStageReceipt,
  setAttemptDirtBefore,
  saveReasoningTrace,
  setReasoningThread,
  getReasoningTrace,
  importSettingsOnce,
  inspectState,
  listOpenAttempts,
  listTaskKinds,
  listTaskTerminalStates,
  loadProjectSettings,
  loadPrototypeConfig,
  listSettingRows,
  listRunsWithAttempts,
  listStageReceipts,
  casUpsertSetting,
  casUpsertSettings,
  openDatabase,
  releaseActivation,
  savePrototypeConfig,
  saveProjectSetting,
  setRunState,
  setRunThread,
  transitionAttempt,
} from "./src/database";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE, type AttemptState } from "./src/state-machine";
import { validateTaskV2 } from "./src/task-v2";
import { reconcile, type IdempotencyTriple } from "./src/reconcile";
import { spawnWithSeam } from "./src/spawn-seam";
import { VISIBLE_CATALOG } from "./src/ui-catalog";
import { bbServiceTier, resolveJevReasoning, writerExecutionSelection, writerServiceTier } from "./src/jev-reasoning";
import { critiquePrompt, parseCritique } from "./src/stages/critique";
import { sha256, stageTransition, validateStageReceipt, type StageId, type StageState } from "./src/stages/contract";

export { rpcContract } from "./src/contracts";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function valueAt(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function stringAt(value: unknown, key: string): string | null {
  const found = valueAt(value, key);
  return typeof found === "string" && found.length > 0 ? found : null;
}

function configuredSetting(settings: Record<string, unknown>, setting: string): unknown {
  if (Object.hasOwn(settings, setting)) return settings[setting];
  const row = VISIBLE_CATALOG.find((item) => item.setting === setting && item.section === "browser-qa");
  return row ? settings[row.storageKey] : undefined;
}

class WriterSelectionError extends Error {}

const NATIVE_WRITER_KEYS = new Set(["writer.provider", "writer.model", "writer.reasoning_effort", "writer.service_tier"]);

function cancelRejection(db: ReturnType<typeof openDatabase>, attempt: NonNullable<ReturnType<typeof getAttempt>>): string | null {
  const run = getRun(db, attempt.run_id);
  if (!run || run.closed_at || (run.state !== "pending" && run.state !== "running")) {
    return `cancel is not legal for ${run?.state ?? "missing"} run`;
  }
  if (!["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(attempt.state)) {
    return `cancel is not legal from ${attempt.state}`;
  }
  return null;
}

async function finishRunSafely(
  bb: BbPluginApi,
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  runId: string,
  closedBy: "rpc" | "cli",
): Promise<void> {
  const run = getRun(db, runId);
  if (!run || run.project_id !== projectId) throw new Error("run does not belong to this project");
  if (run.closed_at) {
    releaseActivation(db, projectId, runId);
    return;
  }
  if (listOpenAttempts(db).some((attempt) => attempt.run_id === runId)) {
    throw new Error("running attempts remain; cancel them before finishing the run");
  }
  if (run.pm_thread_id) {
    const threads = bb.sdk.threads as typeof bb.sdk.threads & {
      listRunning?: (query?: Record<string, unknown>) => Promise<Array<{ id: string }>>;
    };
    if (typeof threads.listRunning !== "function") throw new Error("cannot verify PM status: threads.listRunning is unavailable");
    await threads.stop({ threadId: run.pm_thread_id });
    const info = await threads.get({ threadId: run.pm_thread_id });
    const status = stringAt(info, "status");
    if (status !== "idle" && status !== "error") {
      throw new Error(`cannot finish PM run: PM thread status is ${status ?? "unknown"}`);
    }
    const running = await threads.listRunning({});
    if (running.some((thread) => thread.id === run.pm_thread_id)) {
      throw new Error("cannot finish PM run: PM thread is still listed as running");
    }
  }
  if (!closeRun(db, runId, closedBy)) throw new Error("running attempts remain; cancel them before finishing the run");
  releaseActivation(db, projectId, runId);
}

function outputText(value: unknown): string {
  for (const key of ["text", "output", "lastAssistantText", "content"]) {
    const found = valueAt(value, key);
    if (typeof found === "string") return found;
  }
  return JSON.stringify(value);
}

function asJsonText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function writerPatchFromOutput(output: string): string | null {
  const text = output.trim();
  if (!text) return null;
  if (text.startsWith("diff --git") || text.startsWith("--- ")) return text;
  const lines = text.split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return `--- /dev/null\n+++ b/writer-output.txt\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

function buildTask(config: PrototypeConfig, taskId: string): TaskV2 {
  return taskV2Schema.parse({
    schema_version: 2,
    id: taskId,
    title: "Create the Lane Pilot hello fixture",
    risk: "low",
    lane: "writer",
    project_cwd: config.writerWorkspacePath,
    read_first: ["README.md"],
    interfaces: ["hello.txt must contain exactly: hello from native BB writer"],
    invariants: ["Do not edit files outside this fixture checkout"],
    out_of_scope: ["Lane Pilot plugin source", "user configuration"],
    expected_outputs: ["hello.txt", "tests/hello.test.txt"],
    owns_paths: ["hello.txt", "tests/hello.test.txt"],
    never_touch: [".git/**", ".claude/**"],
    depends_on: [],
    objective: "Create hello.txt and a text test fixture proving its exact content.",
    acceptance: [
      "hello.txt contains exactly 'hello from native BB writer' followed by a newline",
      "tests/hello.test.txt contains the expected line",
    ],
    verify: "tests",
    verification: [{ command:"test \"$(cat hello.txt)\" = \"hello from native BB writer\"", cwd:config.writerWorkspacePath, timeout_sec:30 }],
  });
}

function writerPrompt(task: TaskV2): string {
  return [
    "You are the native BB writer for a bounded Lane Pilot task.",
    "Use the task-v2 contract below. Work only inside owns_paths. Never touch never_touch.",
    renderReadFirstInstructions(task.read_first),
    task.objective,
    "Run the verification commands, then answer with the changed paths and result.",
    JSON.stringify(task, null, 2),
  ].join("\n\n");
}

function planDigest(plan:string): { sha256:string; length:number } {
  return { sha256:createHash("sha256").update(plan, "utf8").digest("hex"), length:Buffer.byteLength(plan, "utf8") };
}

function recordStage(db:ReturnType<typeof openDatabase>, input:{runId:string;taskId:string;stageId:StageId;state:StageState;input:string;attempt?:number;
  providerId?:string|null;model?:string|null;threadId?:string|null;result?:unknown|null;reason?:string|null}): void {
  const previous = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === input.stageId);
  if (previous && !stageTransition(previous.state, input.state)) {
    throw new Error(`illegal stage transition ${input.stageId}: ${previous.state} -> ${input.state}`);
  }
  const result = input.result ?? null;
  const output = result === null ? null : JSON.stringify(result);
  saveStageReceipt(db, validateStageReceipt({
    contractVersion:1, runId:input.runId, taskId:input.taskId, stageId:input.stageId,
    state:input.state, inputSha256:sha256(input.input), outputSha256:output === null ? null : sha256(output),
    attempt:input.attempt ?? 0, providerId:input.providerId ?? null, model:input.model ?? null,
    threadId:input.threadId ?? null, result, reason:input.reason ?? null, updatedAt:Date.now(),
  }));
}

async function runPlanCritique(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;taskId:string;config:PrototypeConfig;task:TaskV2;plan:string})
  : Promise<{allowed:boolean;reason?:string;critique?:unknown}> {
  const settings = loadProjectSettings(input.db, input.projectId);
  const providerId = typeof settings["plan_critique.provider"] === "string" && settings["plan_critique.provider"]
    ? settings["plan_critique.provider"] as string
    : typeof settings["writer.provider"] === "string" ? settings["writer.provider"] as string : input.config.writerProviderId;
  const modelId = typeof settings["plan_critique.model"] === "string" && settings["plan_critique.model"]
    ? settings["plan_critique.model"] as string
    : typeof settings["writer.model"] === "string" && settings["writer.model"] ? settings["writer.model"] as string : input.config.writerModel;
  const mode = settings["plan_critique.mode"] === "advisory" ? "advisory" : "gate";
  const source = `${input.plan}\n\n${JSON.stringify(input.task)}`;
  const base = { runId:input.runId, taskId:input.taskId, stageId:"plan-critique" as const, input:source };
  recordStage(input.db, { ...base, state:"pending" });
  const enabled = settings["plan_critique.enabled"];
  const disabled = enabled === false || enabled === 0
    || (typeof enabled === "string" && ["0", "off", "false", "no"].includes(enabled.trim().toLowerCase()));
  if (disabled) {
    recordStage(input.db, { ...base, state:"skipped", reason:"disabled_by_project_setting" });
    return { allowed:true };
  }
  recordStage(input.db, { ...base, state:"running", providerId, model:modelId });
  let threadId:string|null = null;
  try {
    const [providers, catalog] = await Promise.all([
      input.bb.sdk.providers.list({ hostId:input.config.hostId }),
      input.bb.sdk.providers.models({ providerId, hostId:input.config.hostId }),
    ]);
    const provider = providers.find((row) => row.id === providerId && row.available);
    const model = catalog.models.find((row) => row.id === modelId || row.model === modelId);
    if (!provider || !model) throw new Error("critique_provider_or_model_unavailable");
    const levels = model.supportedReasoningEfforts.map((item) => item.reasoningEffort);
    const configuredEffort = typeof settings["plan_critique.reasoning_effort"] === "string"
      ? settings["plan_critique.reasoning_effort"] as string
      : typeof settings["writer.reasoning_effort"] === "string" ? settings["writer.reasoning_effort"] as string : "medium";
    if (!new Set<string>(levels).has(configuredEffort)) throw new Error(`critique_reasoning_effort_unsupported:${configuredEffort}`);
    const savedTier = settings["plan_critique.service_tier"];
    const tier = savedTier === "fast" || savedTier === "standard" ? savedTier : writerServiceTier(settings);
    const serviceTier = provider.capabilities.supportsServiceTier ? bbServiceTier(tier) : null;
    if (serviceTier && !(provider.serviceTiers ?? []).some((item) => item.id === serviceTier)) {
      throw new Error(`critique_service_tier_unsupported:${serviceTier}`);
    }
    const spawned = await input.bb.sdk.threads.spawn({
      projectId:input.projectId,
      ...writerExecutionSelection(providerId, modelId, configuredEffort, serviceTier),
      prompt:critiquePrompt({ plan:input.plan, task:input.task }),
      environment:{ type:"host", hostId:input.config.hostId,
        workspace:{ type:"unmanaged", path:input.task.project_cwd } },
      visibility:"hidden",
      pluginMetadata:{ role:"plan-critic", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
        stageId:"plan-critique", parentPmThreadId:getRun(input.db, input.runId)?.pm_thread_id ?? null },
    });
    threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("critique_thread_id_missing");
    recordStage(input.db, { ...base, state:"running", providerId, model:modelId, threadId });
    const waited = await input.bb.sdk.threads.wait({ threadId, status:"idle", timeoutMs:90_000 });
    if (!waited.matched) throw new Error("critique_thread_timeout");
    const raw = (await input.bb.sdk.threads.output({ threadId })).output;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
    const critique = parseCritique(raw);
    const blocked = critique.decision === "changes_requested" && mode === "gate";
    const result = { ...critique, mode, rawOutput:raw.slice(0, 12_000) };
    recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId, model:modelId,
      threadId, result, reason:blocked ? "critique_changes_requested" : undefined });
    return blocked ? { allowed:false, reason:"plan_critique_blocked", critique:result } : { allowed:true, critique:result };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (threadId) {
      const thread = await input.bb.sdk.threads.get({ threadId }).catch(() => null);
      if (stringAt(thread, "status") === "active" || stringAt(thread, "status") === "starting") {
        await input.bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      }
    }
    recordStage(input.db, { ...base, state:"failed", providerId, model:modelId, threadId, reason,
      result:{ error:reason } });
    return { allowed:false, reason:`plan_critique_failed:${reason}` };
  }
}

function pmPrompt(runId: string, config: PrototypeConfig): string {
  return [
    "You are the Lane Pilot PM. Do not write production code yourself.",
    `Run id: ${runId}. The production fixture is ${config.writerWorkspacePath}.`,
    "First use Bash only for read probes: `pwd`, `ls -la`, and `cat fixture/README.md` if available.",
    "Then demonstrate the guard by attempting a production write with Write or Bash redirection; report the denial.",
    "Delegate the safe fixture task with `lane_pilot_dispatch_writer`; it returns a runId and attemptId immediately, before the writer completes.",
    "Call `lane_pilot_wait_writer` with that runId (timeoutSec at most 240). If state is still running, call it again with the same runId. Return the final receipt to the user verbatim. Do not attempt to activate another PM.",
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const db = openDatabase(bb);
  const host = bb.hosts.experimental_client({ contract:hostContract });
  const activeWriterTasks = new Set<string>();

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

  async function reconcileAttemptThread(
    projectId: string,
    attempt: NonNullable<ReturnType<typeof getAttempt>>,
  ): Promise<string> {
    const key: IdempotencyTriple = {
      lanePilotRunId:attempt.run_id,
      lanePilotTaskId:attempt.task_id,
      attemptId:attempt.id,
    };
    const result = await reconcile({
      list: async ({ limit, offset }) => (await bb.sdk.threads.list({
        projectId,
        originPluginId:"lane-pilot",
        includeHidden:true,
        limit,
        offset,
      })).map((thread) => ({ id:thread.id })),
      metadata: async (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }),
    }, key);
    if (result.kind === "found") {
      transitionAttempt(db, attempt.id, "running", { threadId:result.threadId });
      return result.threadId;
    }
    if (result.kind === "not_found") {
      transitionAttempt(db, attempt.id, "spawn_rejected", { reason:"reconcile completed on a short page without a matching thread" });
      throw new Error("writer spawn was not created after a complete reconcile scan");
    }
    if (result.kind === "blocked") {
      transitionAttempt(db, attempt.id, "blocked", { reason:`reconcile_${result.reason}` });
      throw new Error(`writer reconcile blocked: ${result.reason}`);
    }
    transitionAttempt(db, attempt.id, "spawn_unknown", { reason:`reconcile_error: ${result.message}` });
    throw new Error(`writer reconcile failed: ${result.message}`);
  }

  async function maybeFinishResumedAttempt(input: {
    projectId:string; attempt:NonNullable<ReturnType<typeof getAttempt>>; writerThreadId:string;
  }): Promise<boolean> {
    if (!input.writerThreadId) return false;
    const thread = await bb.sdk.threads.get({ threadId:input.writerThreadId }).catch(() => null);
    const status = stringAt(thread, "status");
    if (status !== "idle" && status !== "error") return false;
    if (input.attempt.state === "cancel_requested") {
      transitionAttempt(db, input.attempt.id, "canceled", { threadId:input.writerThreadId, reason:"writer stop observed during recovery" });
      refreshRun(input.attempt.run_id);
      return true;
    }
    if (input.attempt.state !== "running") return false;
    const run = getRun(db, input.attempt.run_id);
    const stored = getTask(db, input.attempt.task_id);
    const config = loadPrototypeConfig(db, input.projectId);
    if (!run?.writer_workspace_path || !config || stored?.kind !== "bb") return false;
    const parsed = taskV2Schema.safeParse(stored.contract);
    if (!parsed.success) return false;
    await finishWriterAttempt({
      projectId:input.projectId,
      config:{ ...config, writerWorkspacePath:run.writer_workspace_path },
      task:{ ...parsed.data, project_cwd:run.writer_workspace_path },
      runId:input.attempt.run_id,
      taskId:input.attempt.task_id,
      attemptId:input.attempt.id,
      pmThreadId:run.pm_thread_id ?? "",
      writerThreadId:input.writerThreadId,
      dirtBefore:input.attempt.dirt_before,
    });
    refreshRun(input.attempt.run_id);
    return true;
  }

  async function resumeOrphans(projectId?: string): Promise<{ resumed:string[]; skipped:string[]; finished:string[] }> {
    const resumed: string[] = [];
    const skipped: string[] = [];
    const finished: string[] = [];
    for (const row of listOpenAttempts(db)) {
      if (projectId && row.project_id !== projectId) continue;
      const attempt = getAttempt(db, row.id);
      if (!attempt) continue;
      try {
        const writerThreadId = await reconcileAttemptThread(row.project_id, attempt);
        const current = getAttempt(db, row.id);
        if (current && await maybeFinishResumedAttempt({
          projectId:row.project_id, attempt:current, writerThreadId,
        })) {
          finished.push(row.id);
        } else if (current && current.state === "running") {
          const run = getRun(db, current.run_id);
          const stored = getTask(db, current.task_id);
          const config = loadPrototypeConfig(db, row.project_id);
          const parsed = stored?.kind === "bb" ? taskV2Schema.safeParse(stored.contract) : null;
          if (run?.writer_workspace_path && config && parsed?.success) {
            startWriterTask({
              projectId:row.project_id, runId:current.run_id, taskId:current.task_id,
              firstAttemptId:current.id, pmThreadId:run.pm_thread_id ?? "", writerThreadId,
              dirtBefore:current.dirt_before,
              config:{ ...config, writerWorkspacePath:run.writer_workspace_path },
              task:{ ...parsed.data, project_cwd:run.writer_workspace_path },
              plan:getTaskPlan(db, current.task_id) ?? parsed.data.objective,
            });
          }
        }
        resumed.push(row.id);
      } catch {
        skipped.push(row.id);
      }
    }
    return { resumed, skipped, finished };
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

  function cliSettingsFor(projectId: string, config: PrototypeConfig): Record<string, unknown> {
    const stored = loadProjectSettings(db, projectId);
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

  async function activate(projectId: string, sourceThreadId: string, kind: "bb"|"cli" = "bb"): Promise<{threadId:string; runId:string}> {
    const sourceMetadata = await bb.sdk.threads.getPluginMetadata({ threadId:sourceThreadId });
    if (valueAt(sourceMetadata, "role") === "writer") {
      throw new Error("Lane Pilot writer threads cannot activate a PM");
    }
    const config = loadPrototypeConfig(db, projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${projectId}`);
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
    const existing = getActivation(db, projectId);
    if (existing) refreshRun(existing.run_id);
    const runId = id("lprun");
    createRun(db, runId, projectId, kind, config.writerWorkspacePath);
    claimActivation(db, { projectId, pmThreadId:`pending:${sourceThreadId}`, runId });
    await host.call("writePmSettings", {
      requestedHostId: config.hostId,
      pmWorkspacePath: config.pmWorkspacePath,
    }, { hostId: config.hostId, timeoutMs: 15_000 }).catch(() => undefined);
    const spawned = await bb.sdk.threads.spawn({
      projectId,
      providerId: config.pmProviderId,
      model: config.pmModel,
      prompt: pmPrompt(runId, config),
      environment: {
        type:"host",
        hostId:config.hostId,
        workspace:{ type:"unmanaged", path:config.pmWorkspacePath },
      },
      visibility:"visible",
      pluginMetadata:{ role:"pm", lanePilotRunId:runId },
      executionInputSources:{ providerId:"explicit", model:"explicit" },
    });
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("threads.spawn returned no PM thread id");
    setRunThread(db, runId, threadId);
    claimActivation(db, { projectId, pmThreadId:threadId, runId });
    await resumeOrphans(projectId);
    return { threadId, runId };
  }

  async function spawnWriterAttempt(input: {
    projectId:string; runId:string; taskId:string; attemptId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; pmThreadId:string;
  }): Promise<
    | { ok:true; threadId:string; dirtBefore:import("./src/cli-outcome").DirtSnapshot[] }
    | { ok:false; status:"spawn_rejected"; reason:string; attemptId:string }
  > {
    const dirt = await workspaceDirt(input.config, input.task.project_cwd).catch((cause: unknown) => ({
      ok:false as const,
      reason: cause instanceof Error ? cause.message : String(cause),
    }));
    if (!dirt.ok) {
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "spawn_rejected", { reason:dirt.reason });
      return { ok:false, status:"spawn_rejected", reason:dirt.reason, attemptId:input.attemptId };
    }
    const dirtBefore = dirt.snapshots;
    setAttemptDirtBefore(db, input.attemptId, dirtBefore);
    transitionAttempt(db, input.attemptId, "spawn_requested");
    try {
      const settings = loadProjectSettings(db, input.projectId);
      const writerProviderId = typeof settings["writer.provider"] === "string"
        ? settings["writer.provider"] as string : input.config.writerProviderId;
      const writerModel = typeof settings["writer.model"] === "string" && settings["writer.model"]
        ? settings["writer.model"] as string : input.config.writerModel;
      const requestedServiceTier = bbServiceTier(writerServiceTier(settings));
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>;
      let catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {
        [providers, catalog] = await Promise.all([
          bb.sdk.providers.list({ hostId:input.config.hostId }),
          bb.sdk.providers.models({ providerId:writerProviderId, hostId:input.config.hostId }),
        ]);
      } catch {
        throw new WriterSelectionError("writer_live_catalog_unavailable");
      }
      const provider = providers.find((row) => row.id === writerProviderId);
      if (!provider?.available) throw new WriterSelectionError(`writer_provider_unavailable:${writerProviderId}`);
      const model = catalog.models.find((row) => row.id === writerModel || row.model === writerModel);
      if (!model) throw new WriterSelectionError(`writer_model_unavailable:${writerProviderId}/${writerModel}`);
      const tierIds = new Set(provider.serviceTiers?.map((tier) => tier.id) ?? []);
      if (requestedServiceTier === "fast" && !tierIds.has("fast")) {
        throw new WriterSelectionError(`writer_service_tier_unavailable:${writerProviderId}/fast`);
      }
      const effectiveServiceTier = tierIds.has(requestedServiceTier) ? requestedServiceTier : null;
      const manual = typeof settings["writer.reasoning_effort"] === "string"
        ? settings["writer.reasoning_effort"] as string : "medium";
      const digest = planDigest(input.plan);
      const flag = settings["jev.LANE_JEV_EFFORT"];
      const disabled = flag === false || flag === 0
        || (typeof flag === "string" && ["0", "off", "false", "no"].includes(flag.trim().toLowerCase()));
      const enabled = !disabled;
      let jev:Awaited<ReturnType<typeof host.call<"classifyPlan">>>;
      if (!enabled) {
        jev = { hostId:input.config.hostId, status:"disabled", effort:null, reason:"jev_disabled_by_project_setting",
          planSha256:digest.sha256, sentPlanSha256:null, sourceLength:digest.length, sentLength:null };
      } else {
        try {
          jev = await host.call("classifyPlan", { requestedHostId:input.config.hostId, plan:input.plan }, { hostId:input.config.hostId, timeoutMs:35_000 });
        } catch {
          // The RPC boundary itself can fail before the host adapter returns its normal fail-open result.
          jev = { hostId:input.config.hostId, status:"error", effort:null, reason:"host_classify_rpc_failed",
            planSha256:digest.sha256, sentPlanSha256:null, sourceLength:digest.length, sentLength:null };
        }
      }
      const noSentProof = jev.sentPlanSha256 === null && jev.sentLength === null;
      const validSentProof = jev.sentPlanSha256 === digest.sha256 && jev.sentLength === digest.length;
      const allowedWithoutSentProof = jev.status === "disabled" || jev.reason === "host_classify_rpc_failed";
      if (jev.planSha256 !== digest.sha256 || jev.sourceLength !== digest.length
        || (noSentProof ? !allowedWithoutSentProof : !validSentProof)) {
        throw new Error("Jev full-plan transport proof mismatch");
      }
      const supported = new Set<string>(model.supportedReasoningEfforts.map((item) => item.reasoningEffort));
      const jevDecision = jev.status === "ok" ? jev.effort : null;
      const choice = resolveJevReasoning({
        status:jev.status, jevDecision, manualLevel:manual,
        supportedLevels:supported,
      });
      const fallbackReason = [choice.fallbackReason,
        jev.status !== "ok" && jev.reason ? `${jev.reason}` : null,
        choice.manualSupported === false ? `manual_fallback_unsupported:${manual}` : null,
      ].filter(Boolean).join(";") || null;
      const requested = choice.requested;
      const effective = choice.effective;
      const trace = {
        planSha256:digest.sha256, sentPlanSha256:jev.sentPlanSha256, sourceLength:digest.length, sentLength:jev.sentLength,
        jevStatus:jev.status, jevDecision, requestedReasoningLevel:requested,
        effectiveReasoningLevel:effective, fallbackReason,
        providerId:writerProviderId, model:writerModel, serviceTier:effectiveServiceTier,
        requestedServiceTier,
        runId:input.runId, attemptId:input.attemptId, threadId:null,
      } as const;
      saveReasoningTrace(db, trace);
      bb.log.info(`Lane Pilot writer reasoning trace ${JSON.stringify(trace)}`);
      if (choice.manualSupported === false) {
        throw new WriterSelectionError(`manual_writer_reasoning_effort_unsupported:${effective}; supported=${[...supported].join(",")}`);
      }
      const execution = writerExecutionSelection(writerProviderId, writerModel, effective, effectiveServiceTier);
      const spawned = await spawnWithSeam(() => bb.sdk.threads.spawn({
        projectId: input.projectId,
        ...execution,
        prompt: writerPrompt(input.task),
        environment: {
          type:"host",
          hostId:input.config.hostId,
          workspace:{ type:"unmanaged", path:input.task.project_cwd },
        },
        visibility:"hidden",
        pluginMetadata:{
          role:"writer",
          lanePilotRunId:input.runId,
          lanePilotTaskId:input.taskId,
          attemptId:input.attemptId,
          parentPmThreadId:input.pmThreadId,
        },
      }));
      const writerThreadId = stringAt(spawned, "id") ?? "";
      if (!writerThreadId) throw new Error("threads.spawn returned no writer thread id");
      transitionAttempt(db, input.attemptId, "running", { threadId:writerThreadId });
      setReasoningThread(db, input.attemptId, writerThreadId);
      const spawnedTrace = getReasoningTrace(db, input.attemptId);
      if (spawnedTrace) bb.log.info(`Lane Pilot writer execution ${JSON.stringify({ attemptId:input.attemptId, threadId:writerThreadId, providerId:spawnedTrace.providerId, model:spawnedTrace.model, reasoningLevel:spawnedTrace.effectiveReasoningLevel, serviceTier:spawnedTrace.serviceTier })}`);
      return { ok:true, threadId:writerThreadId, dirtBefore };
    } catch (cause) {
      if (cause instanceof WriterSelectionError) {
        const reason = cause.message;
        transitionAttempt(db, input.attemptId, "spawn_rejected", { reason });
        return { ok:false, status:"spawn_rejected", reason, attemptId:input.attemptId };
      }
      transitionAttempt(db, input.attemptId, "spawn_unknown", { reason:cause instanceof Error ? cause.message : String(cause) });
      const attempt = getAttempt(db, input.attemptId);
      if (!attempt) throw new Error(`persisted attempt disappeared after spawn_unknown: ${input.attemptId}`);
      return { ok:true, threadId: await reconcileAttemptThread(input.projectId, attempt), dirtBefore };
    }
  }

  async function workspaceDirt(config: PrototypeConfig, workspacePath = config.writerWorkspacePath): Promise<{ ok:true; paths:string[]; snapshots:DirtSnapshot[] } | { ok:false; reason:string }> {
    const ran = await host.call("runCommand", {
      requestedHostId: config.hostId,
      command: "python3 - <<'PY'\nimport hashlib, json, os, subprocess\nraw = subprocess.run([\"git\", \"status\", \"--porcelain\", \"-z\", \"-uall\"], check=True, stdout=subprocess.PIPE).stdout\nparts = raw.split(bytes([0]))\npaths = []\ni = 0\nwhile i < len(parts) and parts[i]:\n    item = parts[i]\n    i += 1\n    name = item[3:]\n    if not name:\n        raise ValueError(\"empty git path\")\n    paths.append(name)\n    if item[:2] in (b\"R \", b\"C \", b\" R\", b\" C\"):\n        if i >= len(parts) or not parts[i]:\n            raise ValueError(\"missing rename source\")\n        paths.append(parts[i])\n        i += 1\nrows = []\nfor raw_path in sorted(set(paths)):\n    path = os.fsdecode(raw_path)\n    if os.path.isfile(path):\n        with open(path, \"rb\") as stream:\n            digest = hashlib.sha256(stream.read()).hexdigest()\n    elif os.path.lexists(path):\n        raise ValueError(\"dirty path is not regular: \" + path)\n    else:\n        digest = \"\"\n    rows.append({\"path\": path, \"sha256\": digest})\nprint(json.dumps(rows, ensure_ascii=True))\nPY",
      cwd: workspacePath,
      timeoutSec: 30,
    }, { hostId:config.hostId, timeoutMs:30_000 }).catch((cause: unknown) => ({
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

  async function runVerification(config: PrototypeConfig, task: TaskV2): Promise<VerifyResult[]> {
    const results: VerifyResult[] = [];
    for (const command of task.verification) {
      const ran = await host.call("runCommand", {
        requestedHostId: config.hostId,
        command: command.command,
        cwd: command.cwd,
        timeoutSec: command.timeout_sec,
      }, { hostId:config.hostId, timeoutMs:(command.timeout_sec ?? 30) * 1000 }).catch((cause: unknown) => ({
        hostId: config.hostId,
        exitCode: 1,
        stdout: "",
        stderr: cause instanceof Error ? cause.message : String(cause),
      }));
      results.push({ command:command.command, exitCode:ran.exitCode, stderr:ran.stderr });
    }
    return results;
  }

  async function persistWriterAcceptance(input: {
    config:PrototypeConfig; task:TaskV2; runId:string; taskId:string; attempt:number;
    attemptId:string; pmThreadId:string; writerThreadId:string; output:string; verification:VerifyResult[];
  }): Promise<Record<string,unknown>> {
    const reportText = bbWriterReportMarkdown(input.task, input.attempt);
    const reasoningTrace = getReasoningTrace(db, input.attemptId);
    const acceptance = buildAcceptanceV2({
      task:input.task, attempt:input.attempt,
      providerId:reasoningTrace?.providerId ?? input.config.writerProviderId,
      model:reasoningTrace?.model ?? input.config.writerModel, reportText,
    });
    const validation = validateAcceptanceV2(acceptance);
    if (!validation.ok) throw new Error(`upstream acceptance-v2 rejected generated receipt: ${validation.errors.join("; ")}`);
    const artifactDir = acceptanceArtifactDir(input.task.project_cwd, input.runId, input.taskId);
    const internalReceipt = {
      schemaVersion:1, status:"accepted", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
      attemptId:input.attemptId, pmThreadId:input.pmThreadId, writerThreadId:input.writerThreadId,
      ownsPaths:input.task.owns_paths, readFirst:parseReadFirstHints(input.task.read_first),
      output:input.output, verification:input.verification,
      reasoning:reasoningTrace ? [reasoningTrace] : [],
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
    config:PrototypeConfig; task:TaskV2; writerThreadId:string; attemptId:string; dirtBefore:import("./src/cli-outcome").DirtSnapshot[];
  }): Promise<{ status:"accepted"|"empty_output"|"validation_failed"; reason?:string; output:string; produced:string[]; verification:VerifyResult[] }> {
    const output = await bb.sdk.threads.output({ threadId:input.writerThreadId });
    const dirt = await workspaceDirt(input.config, input.task.project_cwd);
    if (!dirt.ok) {
      return { status:"validation_failed", reason:dirt.reason, output:outputText(output), produced:[], verification:[] };
    }
    const unverifiable = input.dirtBefore
      .filter((before) => !before.sha256 && dirt.snapshots.some((after) => after.path === before.path))
      .map((file) => file.path);
    if (unverifiable.length > 0) {
      return {
        status:"validation_failed",
        reason:`cannot compare pre-existing dirty file content: ${unverifiable.join(", ")}`,
        output:outputText(output), produced:[], verification:[],
      };
    }
    const produced = attemptProduced(dirt.snapshots, input.dirtBefore);
    const unowned = findUnownedChanges(produced, input.task);
    if (unowned.length) {
      return { status:"validation_failed", reason:`writer changed paths outside owns_paths or inside never_touch: ${unowned.join(", ")}`,
        output:outputText(output), produced, verification:[] };
    }
    const contents: Record<string, string | null> = {};
    for (const rel of new Set([...input.task.expected_outputs, ...produced])) {
      const absolute = rel.startsWith("/") ? rel : `${input.task.project_cwd}/${rel}`;
      const read = await bb.sdk.files.read({
        hostId:input.config.hostId,
        rootPath:input.task.project_cwd,
        path:absolute,
      }).catch(() => null);
      contents[rel] = read ? stringAt(read, "content") : null;
    }
    const verifies = await runVerification(input.config, input.task);
    const classified = classifyWriterOutput({ task:input.task, produced, contents, verifies });
    if (input.task.expected_outputs.includes("hello.txt") && input.task.expected_outputs.includes("tests/hello.test.txt")) {
      const helloOk = contents["hello.txt"] === "hello from native BB writer\n";
      const testOk = contents["tests/hello.test.txt"] === "hello from native BB writer\n";
      if (!helloOk || !testOk) {
        return {
          status: contents["hello.txt"] == null && contents["tests/hello.test.txt"] == null ? "empty_output" : "validation_failed",
          reason:"fixture output content mismatch",
          output:outputText(output),
          produced, verification:verifies,
        };
      }
    }
    if (!classified.ok) {
      return { status:classified.state, reason:classified.reason, output:outputText(output), produced, verification:verifies };
    }
    return { status:"accepted", output:outputText(output), produced, verification:verifies };
  }

  async function finishWriterAttempt(input: {
    projectId:string; config:PrototypeConfig; task:TaskV2;
    runId:string; taskId:string; attemptId:string; pmThreadId:string; writerThreadId:string;
    dirtBefore:import("./src/cli-outcome").DirtSnapshot[];
  }): Promise<Record<string,unknown>> {
    try {
      const deadline = Date.now() + 600_000;
      let completedThread: unknown;
      while (Date.now() < deadline) {
        const pollStarted = Date.now();
        const currentThread = await getThreadBounded(input.writerThreadId);
        const currentStatus = stringAt(currentThread, "status");
        if (currentStatus === "error") {
          transitionAttempt(db, input.attemptId, "provider_error", { reason:"writer thread status error" });
          return { status:"provider_error", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
        }
        if (currentStatus === "idle") {
          completedThread = currentThread;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(
          Math.max(0, 2_000 - (Date.now() - pollStarted)), Math.max(1, deadline - Date.now()),
        )));
      }
      if (!completedThread) {
        transitionAttempt(db, input.attemptId, "timeout", { reason:"writer thread did not reach idle before the deadline" });
        await bb.sdk.threads.stop({ threadId:input.writerThreadId }).catch(() => undefined);
        return { status:"timeout", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      const currentAttempt = getAttempt(db, input.attemptId);
      if (currentAttempt?.state === "cancel_requested" || currentAttempt?.state === "canceled") {
        if (currentAttempt.state === "cancel_requested") transitionAttempt(db, input.attemptId, "canceled", { threadId:input.writerThreadId, reason:"writer stop observed before validation" });
        return { status:"canceled", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      const checked = await validateWriterResult({
        config:input.config, task:input.task, writerThreadId:input.writerThreadId, attemptId:input.attemptId,
        dirtBefore:input.dirtBefore,
      });
      if (checked.status !== "accepted") {
        transitionAttempt(db, input.attemptId, checked.status, { reason:checked.reason });
        return { ...checked, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      const receipt = await persistWriterAcceptance({
        config:input.config, task:input.task, runId:input.runId, taskId:input.taskId,
        attempt:countAttempts(db, input.runId, input.taskId), attemptId:input.attemptId,
        pmThreadId:input.pmThreadId, writerThreadId:input.writerThreadId, output:checked.output, verification:checked.verification,
      });
      transitionAttempt(db, input.attemptId, "accepted");
      return { ...receipt, verification:checked.verification, produced:checked.produced };
    } catch (cause) {
      const thread = await getThreadBounded(input.writerThreadId);
      if (stringAt(thread, "status") === "error") {
        transitionAttempt(db, input.attemptId, "provider_error", { reason:cause instanceof Error ? cause.message : String(cause) });
        return { status:"provider_error", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      throw cause;
    }
  }

  function startWriterTask(input:{
    projectId:string; runId:string; taskId:string; firstAttemptId:string; pmThreadId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; writerThreadId?:string; dirtBefore?:DirtSnapshot[];
  }): void {
    const key = `${input.runId}:${input.taskId}`;
    if (activeWriterTasks.has(key)) return;
    activeWriterTasks.add(key);
    recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"running",
      input:input.plan, attempt:countAttempts(db, input.runId, input.taskId) });
    let attemptId = input.firstAttemptId;
    let writerThreadId = input.writerThreadId;
    let dirtBefore = input.dirtBefore ?? [];
    let last: Record<string, unknown> = {};
    void (async () => {
      while (countAttempts(db, input.runId, input.taskId) <= MAIN_ATTEMPT_LIMIT) {
        if (!writerThreadId) {
          const spawned = await spawnWriterAttempt({
            projectId:input.projectId, runId:input.runId, taskId:input.taskId, attemptId,
            config:input.config, task:input.task, plan:input.plan, pmThreadId:input.pmThreadId,
          });
          if (!spawned.ok) {
            last = { status:spawned.status, reason:spawned.reason, attemptId:spawned.attemptId };
          } else {
            writerThreadId = spawned.threadId;
            dirtBefore = spawned.dirtBefore;
          }
        }
        if (writerThreadId) {
          last = await finishWriterAttempt({
            projectId:input.projectId, config:input.config, task:input.task, runId:input.runId,
            taskId:input.taskId, attemptId, pmThreadId:input.pmThreadId, writerThreadId, dirtBefore,
          });
        }
        if (last.status === "accepted") break;
        const failed = String(last.status) as AttemptState;
        if (!RETRY_ELIGIBLE.includes(failed)) break;
        const attempt = getAttempt(db, attemptId);
        if (attempt?.state === "spawn_unknown" || attempt?.state === "spawn_requested") {
          writerThreadId = await reconcileAttemptThread(input.projectId, attempt).catch(() => "");
        } else if (attempt) {
          const scanned = await reconcile({
            list: async ({ limit, offset }) => (await bb.sdk.threads.list({
              projectId:input.projectId, originPluginId:"lane-pilot", includeHidden:true, limit, offset,
            })).map((thread) => ({ id:thread.id })),
            metadata: async (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }),
          }, { lanePilotRunId:attempt.run_id, lanePilotTaskId:attempt.task_id, attemptId:attempt.id });
          if (scanned.kind === "blocked" || scanned.kind === "error") {
            if (scanned.kind === "blocked") transitionAttempt(db, attempt.id, "blocked", { reason:`reconcile_${scanned.reason}` });
            last = { ...last, status:"blocked", reason:scanned.kind === "blocked" ? scanned.reason : scanned.message };
            break;
          }
        }
        if (countAttempts(db, input.runId, input.taskId) >= MAIN_ATTEMPT_LIMIT) {
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) {
            transitionAttempt(db, latest.id, "blocked", { reason:"retry limit 2 exhausted" });
            last = { ...last, status:"blocked", reason:"retry limit 2 exhausted" };
          }
          break;
        }
        attemptId = id("lpattempt");
        createAttempt(db, { id:attemptId, runId:input.runId, taskId:input.taskId });
        writerThreadId = undefined;
        dirtBefore = [];
      }
      const accepted = last.status === "accepted";
      const reason = accepted ? undefined : String(last.reason ?? last.status ?? "writer_failed");
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
        if (current?.state === "pending") {
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
        }
        const terminal = accepted ? "passed" : last.status === "canceled" ? "canceled" : "failed";
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:terminal,
          input:input.plan, attempt:countAttempts(db, input.runId, input.taskId), threadId:writerThreadId,
          result:accepted ? stageId === "verification"
            ? { produced:last.produced, verification:last.verification }
            : last : null, reason:accepted ? undefined : reason });
      }
      refreshRun(input.runId);
    })().catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      const reason = `internal_error: ${message}`;
      bb.log.error(`Lane Pilot writer attempt ${attemptId} failed: ${message}`);
      const attempt = getAttempt(db, attemptId);
      if (attempt && ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested", "provider_error", "timeout", "empty_output", "validation_failed"].includes(attempt.state)) {
        transitionAttempt(db, attemptId, "blocked", { threadId:writerThreadId, reason });
      }
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
        if (!current || current.state === "passed" || current.state === "failed" || current.state === "skipped") continue;
        if (current.state === "pending") recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId,
          state:"failed", input:input.plan,
          attempt:countAttempts(db, input.runId, input.taskId), threadId:writerThreadId, reason });
      }
      try {
        refreshRun(input.runId);
      } catch (refreshCause) {
        bb.log.error(`Lane Pilot failed to refresh run ${input.runId} after attempt ${attemptId} error: ${refreshCause instanceof Error ? refreshCause.message : String(refreshCause)}`);
      }
    }).finally(() => {
      activeWriterTasks.delete(key);
    });
  }

  async function dispatchWriter(args:{threadId:string; projectId:string; task?:TaskV2; plan?:string}): Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    const config = loadPrototypeConfig(db, args.projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${args.projectId}`);
    const run = getRun(db, runId);
    const workspacePath = run?.writer_workspace_path;
    if (!run || !workspacePath) {
      const reason = "run has no persisted writerWorkspacePath; reactivate Lane Pilot to create a run with a workspace snapshot";
      return { runId, state:"rejected", reason, unapplied:[{ key:"task.project_cwd", reason }] };
    }
    const runConfig = { ...config, writerWorkspacePath:workspacePath };
    if (listTaskKinds(db, runId).includes("cli")) {
      throw new Error("V1: BB writer cannot join a CLI run-controller run");
    }
    const taskId = args.task?.id ?? id("lptask");
    const prepared = args.task ?? buildTask(runConfig, taskId);
    const canonicalPlan = args.plan ?? prepared.objective;
    if (canonicalPlan.trim().length === 0) throw new Error("canonical plan must be non-empty");
    const valid = validateTaskV2(prepared);
    if (!valid.ok) throw new Error(`task-v2 invalid: ${valid.errors.join("; ")}`);
    if (resolve(valid.task.project_cwd) !== resolve(workspacePath)) {
      const reason = `task.project_cwd must equal the configured writerWorkspacePath (${workspacePath})`;
      return { runId, state:"rejected", reason, unapplied:[{ key:"task.project_cwd", reason }] };
    }
    valid.task.project_cwd = workspacePath;
    createTask(db, { id:taskId, runId, kind:"bb", contract:valid.task });
    saveTaskPlan(db, taskId, canonicalPlan);
    const rejectPreflight = (reason:string):Record<string,unknown> => {
      recordStage(db, { runId, taskId, stageId:"plan-critique", state:"blocked", input:canonicalPlan, reason });
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        recordStage(db, { runId, taskId, stageId, state:"skipped", input:canonicalPlan,
          reason:"task preflight failed before stage execution" });
      }
      setRunState(db, runId, "blocked");
      refreshRun(runId);
      return { runId, taskId, state:"blocked", reason, stages:listStageReceipts(db, runId, taskId) };
    };
    try {
      parseReadFirstHints(valid.task.read_first);
    } catch (cause) {
      return rejectPreflight(cause instanceof Error ? cause.message : String(cause));
    }
    const ownershipError = validateOwnershipContract(valid.task);
    if (ownershipError) return rejectPreflight(ownershipError);
    const critique = await runPlanCritique({ bb, db, projectId:args.projectId, runId, taskId,
      config:runConfig, task:valid.task, plan:canonicalPlan });
    if (!critique.allowed) {
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        recordStage(db, { runId, taskId, stageId, state:"skipped", input:canonicalPlan,
          reason:"upstream plan-critique stage did not pass" });
      }
      setRunState(db, runId, "blocked");
      return { runId, taskId, state:"blocked", reason:critique.reason, stages:listStageReceipts(db, runId, taskId) };
    }
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
      recordStage(db, { runId, taskId, stageId, state:"pending", input:canonicalPlan });
    }
    const attemptId = id("lpattempt");
    createAttempt(db, { id:attemptId, runId, taskId });
    startWriterTask({
      projectId:args.projectId, runId, taskId, firstAttemptId:attemptId,
      pmThreadId:args.threadId, config:runConfig, task:valid.task, plan:canonicalPlan,
    });
    return { runId, attemptId, writerThreadId:null, state:"queued", stages:listStageReceipts(db, runId, taskId) };
  }

  async function waitWriter(args:{threadId:string; projectId:string; runId:string; timeoutSec:number}): Promise<Record<string, unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm" || stringAt(metadata, "lanePilotRunId") !== args.runId) {
      throw new Error("runId does not belong to this Lane Pilot PM thread");
    }
    const run = getRun(db, args.runId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId) {
      throw new Error("run does not belong to this PM thread and project");
    }
    const deadline = Date.now() + Math.min(240, Math.max(1, args.timeoutSec)) * 1000;
    while (Date.now() < deadline) {
      const listedRun = listRunsWithAttempts(db, args.projectId).find((item) => item.id === args.runId);
      const latestByTask = new Map<string, {id:string;state:string;attempt_no:number;thread_id:string|null;reason:string|null;task_id:string}>();
      for (const attempt of listedRun?.attempts ?? []) {
        if (!latestByTask.has(attempt.task_id) || latestByTask.get(attempt.task_id)!.attempt_no < attempt.attempt_no) {
          latestByTask.set(attempt.task_id, attempt);
        }
      }
      for (const attempt of latestByTask.values()) {
        if ((attempt.state !== "running" && attempt.state !== "cancel_requested") || !attempt.thread_id) continue;
        const thread = await getThreadBounded(attempt.thread_id);
        const threadStatus = stringAt(thread, "status");
        if (threadStatus === "error" || (attempt.state === "cancel_requested" && threadStatus === "idle")) {
          const failedState = attempt.state === "cancel_requested" ? "canceled" : "provider_error";
          const reason = attempt.state === "cancel_requested" ? "writer stop observed" : "writer thread status error";
          transitionAttempt(db, attempt.id, failedState, { reason });
          refreshRun(args.runId);
          latestByTask.set(attempt.task_id, { ...attempt, state:failedState, reason });
        }
      }
      for (const attempt of latestByTask.values()) {
        const key = `${args.runId}:${attempt.task_id}`;
        if (attempt.state !== "provider_error" || activeWriterTasks.has(key)) continue;
        const task = getTask(db, attempt.task_id);
        const currentRun = getRun(db, args.runId);
        const config = loadPrototypeConfig(db, args.projectId);
        const parsed = task?.kind === "bb" ? taskV2Schema.safeParse(task.contract) : null;
        if (currentRun?.writer_workspace_path && currentRun.pm_thread_id && config && parsed?.success) {
          startWriterTask({
            projectId:args.projectId,
            runId:args.runId,
            taskId:attempt.task_id,
            firstAttemptId:attempt.id,
            pmThreadId:currentRun.pm_thread_id,
            writerThreadId:attempt.thread_id ?? undefined,
            config:{ ...config, writerWorkspacePath:currentRun.writer_workspace_path },
            task:{ ...parsed.data, project_cwd:currentRun.writer_workspace_path },
            plan:getTaskPlan(db, attempt.task_id) ?? parsed.data.objective,
          });
        }
      }
      const states = listTaskTerminalStates(db, args.runId);
      const state = states.length && states.every((item) => !["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(item))
        ? (states.includes("accepted") ? "accepted" : states.includes("blocked") ? "blocked" : states.at(-1)!)
        : "running";
      if (state !== "running") {
        if (state === "provider_error" && [...activeWriterTasks].some((key) => key.startsWith(`${args.runId}:`))) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const settings = loadProjectSettings(db, args.projectId);
        const baseReceipt = valueAt(settings["writer.lastResult"], "lanePilotRunId") === args.runId ? settings["writer.lastResult"] : null;
        const reasoning = [...latestByTask.values()].map((attempt) => getReasoningTrace(db, attempt.id)).filter(Boolean);
        const receipt = baseReceipt && typeof baseReceipt === "object"
          ? { ...baseReceipt as Record<string, unknown>, reasoning }
          : baseReceipt;
        const reasons = [...latestByTask.values()].map((attempt) => attempt.reason).filter((reason): reason is string => Boolean(reason));
        return { runId:args.runId, state, receipt, stages:listStageReceipts(db, args.runId), ...(reasons.length ? { reason:reasons.join("; ") } : {}) };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const attempts = listOpenAttempts(db).filter((attempt) => attempt.run_id === args.runId);
    return {
      runId:args.runId,
      attemptId:attempts.at(-1)?.id ?? null,
      writerThreadId:attempts.at(-1)?.thread_id ?? null,
      state:"running",
      stages:listStageReceipts(db, args.runId),
      message:"Писатель ещё работает. Вызови lane_pilot_wait_writer ещё раз с тем же runId.",
    };
  }

  async function dispatchCli(args:{
    threadId:string; projectId:string; binary?:"run-controller"|"lane-ctl"; subcommand?:string;
    taskFile?:string; taskId?:string; runDir?:string;
  }): Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    const config = loadPrototypeConfig(db, args.projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${args.projectId}`);
    if (listTaskKinds(db, runId).includes("bb")) {
      throw new Error("V1: CLI writer cannot join a BB writer run");
    }
    const binary = args.binary ?? "run-controller";
    const subcommand = args.subcommand ?? "run";
    const settings = cliSettingsFor(args.projectId, config);
    const runDir = args.runDir
      ?? (typeof settings["ops.run_dir"] === "string" ? settings["ops.run_dir"] : undefined)
      ?? `${config.writerWorkspacePath}/.agents/runs/lane-pilot-${runId}`;
    const invocation = buildCliInvocation({
      binary,
      subcommand,
      settings,
      required: requiredCliFlags({
        binary,
        subcommand,
        runDir,
        projectCwd: String(settings["ops.project_cwd"] ?? config.writerWorkspacePath),
        taskFile: args.taskFile ?? (typeof settings["ops.task_file"] === "string" ? settings["ops.task_file"] : undefined),
        taskId: args.taskId ?? (typeof settings["ops.task_id"] === "string" ? settings["ops.task_id"] : undefined),
      }),
    });
    const invalidSetting = invocation.unapplied.find((row) => row.reason.startsWith("invalid value;"));
    if (invalidSetting) {
      return {
        status:"blocked",
        reason:`invalid setting ${invalidSetting.key}: ${invalidSetting.reason}`,
        applied:invocation.applied,
        unapplied:invocation.unapplied,
        argv:invocation.argv,
        env:invocation.env,
      };
    }
    const executed = await host.call("runCli", {
      requestedHostId: config.hostId,
      binary,
      argv: invocation.argv,
      env: invocation.env,
      cwd: config.writerWorkspacePath,
    }, { hostId:config.hostId, timeoutMs:180_000 });
    const outcome = classifyCliOutcome({
      subcommand,
      exitCode:executed.exitCode,
      stdout:executed.stdout,
    });
    const receiptPath = `${runDir}/cli-receipt.json`;
    const receipt = {
      schemaVersion:1,
      kind:"cli",
      status: outcome.status,
      taskAccepted: outcome.taskAccepted,
      upstreamAccepted: outcome.upstreamAccepted,
      upstreamStatus: outcome.upstreamStatus,
      reason: outcome.reason,
      lanePilotRunId:runId,
      pmThreadId:args.threadId,
      binary,
      argv: executed.argv,
      env: executed.env,
      exitCode: executed.exitCode,
      stdout: executed.stdout,
      stderr: executed.stderr,
      applied: invocation.applied,
      unapplied: invocation.unapplied,
      receiptPath,
    };
    await bb.sdk.files.write({
      hostId: config.hostId,
      rootPath: config.writerWorkspacePath,
      path: receiptPath,
      content: `${JSON.stringify(receipt, null, 2)}\n`,
      contentEncoding: "utf8",
      createParents: true,
      expectedSha256: null,
    });
    const mutating = subcommand === "start" || subcommand === "run";
    let attemptId: string | null = null;
    if (mutating) {
      const existing = db.prepare("SELECT id FROM lane_pilot_task WHERE run_id=? AND kind='cli'")
        .get(runId) as { id: string } | undefined;
      const taskId = existing?.id ?? id("lptask");
      if (!existing) {
        createTask(db, { id: taskId, runId, kind:"cli", contract:{ binary, subcommand, argv:executed.argv, receiptPath } });
      }
      attemptId = id("lpattempt");
      createAttempt(db, { id: attemptId, runId, taskId });
      transitionAttempt(db, attemptId, outcome.status, { reason: outcome.reason });
    }
    saveProjectSetting(db, args.projectId, cliReceiptRunKey(runId), JSON.stringify(receipt));
    if (attemptId) {
      saveProjectSetting(db, args.projectId, cliReceiptAttemptKey(attemptId), JSON.stringify(receipt));
    }
    setRunState(db, runId, outcome.status);
    return receipt;
  }

  async function runBrowserQa(args:{threadId:string;projectId:string;runId:string;taskId:string;url:string;cases:string[];envClass:"local"|"staging"|"preview"|"production"|"unknown";viewports:string;authorized:boolean})
    : Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata,"role") !== "pm" || stringAt(metadata,"lanePilotRunId") !== args.runId) {
      throw new Error("runId does not belong to this Lane Pilot PM thread");
    }
    const run = getRun(db,args.runId);
    const config = loadPrototypeConfig(db,args.projectId);
    const taskRow = getTask(db,args.taskId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId || !config || !taskRow || taskRow.run_id !== args.runId || taskRow.kind !== "bb") {
      throw new Error("task does not belong to this PM run and project");
    }
    const task = taskV2Schema.parse(taskRow.contract);
    if (task.project_cwd !== run.writer_workspace_path) throw new Error("task workspace no longer matches the immutable run workspace");
    const acceptance = listStageReceipts(db,args.runId,args.taskId).find((row) => row.stageId === "acceptance-receipt");
    if (acceptance?.state !== "passed") throw new Error("browser QA requires an accepted writer receipt first");
    const settings = loadProjectSettings(db,args.projectId);
    const enabled = configuredSetting(settings,"browser_qa.enabled");
    const providerValue = configuredSetting(settings,"browser_qa.provider");
    const provider = providerValue == null || providerValue === "jev" ? "jev"
      : providerValue === "codex" ? "codex" : providerValue === "claude" ? "claude" : "unsupported";
    const modelSetting = configuredSetting(settings,"browser_qa.model");
    const configuredModelValue = typeof modelSetting === "string" ? modelSetting.trim() : "";
    const configuredModel = configuredModelValue && configuredModelValue !== "provider-specific" ? configuredModelValue : undefined;
    const reasoningSetting = configuredSetting(settings,"browser_qa.reasoning_effort");
    const configuredReasoningValue = typeof reasoningSetting === "string" ? reasoningSetting.trim() : "";
    const configuredReasoning = configuredReasoningValue && configuredReasoningValue !== "provider-specific" ? configuredReasoningValue : undefined;
    const base = { runId:args.runId, taskId:args.taskId, stageId:"browser-qa" as const,
      input:JSON.stringify({url:args.url,cases:args.cases,envClass:args.envClass,viewports:args.viewports,authorized:args.authorized}),
      attempt:countAttempts(db,args.runId,args.taskId), providerId:`browser-qa-${provider}`,
      model:configuredModel ?? null };
    const existing = listStageReceipts(db,args.runId,args.taskId).find((row) => row.stageId === "browser-qa");
    if (existing) return { runId:args.runId,taskId:args.taskId,state:existing.state,reason:"browser QA stage already has a receipt; create a new task for another proof run",stage:existing };
    recordStage(db,{...base,state:"pending"});
    const enabledOff = enabled === false || enabled === 0 || (typeof enabled === "string" && ["false","off","0","no"].includes(enabled.toLowerCase()));
    if (enabledOff) {
      recordStage(db,{...base,state:"skipped",reason:"disabled_by_project_setting"});
      return {runId:args.runId,taskId:args.taskId,state:"skipped",reason:"disabled_by_project_setting",stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (enabled != null && ![true,1,"true","on","1","yes",false,0,"false","off","0","no"].includes(enabled as never)) {
      const reason = "invalid_browser_qa_enabled_setting";
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    const approve = configuredSetting(settings,"browser_qa.approve");
    if (approve === "never") {
      recordStage(db,{...base,state:"skipped",reason:"browser_qa.approve=never"});
      return {runId:args.runId,taskId:args.taskId,state:"skipped",reason:"browser_qa.approve=never",stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (approve != null && approve !== "auto") {
      const reason = `unsupported_browser_qa_approval_setting:${String(approve)}`;
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (provider === "unsupported") {
      const reason = `unsupported_browser_qa_provider:${String(providerValue)}`;
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (provider === "claude") {
      recordStage(db,{...base,state:"blocked",reason:"claude browser QA requires the configured chrome-devtools MCP RPC; no schema-verified RPC is available"});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason:"claude browser QA requires the configured chrome-devtools MCP RPC; no schema-verified RPC is available",stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (provider === "jev" && configuredModel && configuredModel !== "typesafe/jev-1.13") {
      const reason = "jev_runner_model_is_fixed: choose browser_qa.provider=codex to apply a custom model";
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (provider === "jev" && configuredReasoning) {
      const reason = "jev_runner_does_not_accept_reasoning_effort; clear that setting or select codex";
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    const model = configuredModel;
    const reasoning = configuredReasoning as "low"|"medium"|"high"|"xhigh"|"max"|undefined;
    const backendValue = configuredSetting(settings,"browser_qa.backend");
    const backend = backendValue == null || backendValue === "chrome-qa" ? "chrome-qa"
      : backendValue === "live-chrome" || backendValue === "headless" ? backendValue : null;
    if (!backend) {
      const reason = `unsupported_browser_qa_backend:${String(backendValue)}`;
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    const timeoutValue = configuredSetting(settings,"browser_qa.timeout_sec");
    const timeoutSec = typeof timeoutValue === "number" && Number.isInteger(timeoutValue) ? Math.min(1800,Math.max(30,timeoutValue)) : 900;
    recordStage(db,{...base,state:"running",providerId:base.providerId,model});
    try {
      const result = await host.call("runBrowserQa",{
        requestedHostId:config.hostId, projectCwd:task.project_cwd, url:args.url,
        slug:`lp-qa-${args.runId.replace(/[^a-z0-9-]/gi,"").slice(-12)}-${args.taskId.replace(/[^a-z0-9-]/gi,"").slice(-12)}-${Date.now()}`.toLowerCase(),
        cases:args.cases, envClass:args.envClass, viewports:args.viewports, authorized:args.authorized,
        provider, ...(model ? {model} : {}), ...(reasoning ? {reasoningEffort:reasoning} : {}), backend, timeoutSec,
      },{hostId:config.hostId,timeoutMs:(timeoutSec+30)*1000});
      if (result.hostId !== config.hostId) throw new Error("browser QA result came from a different host");
      const mismatches = [
        model && result.actualModel !== model ? `configured_model=${model}, actual_model=${result.actualModel ?? "unknown"}` : null,
        reasoning && result.actualReasoningEffort !== reasoning ? `configured_effort=${reasoning}, actual_effort=${result.actualReasoningEffort ?? "unknown"}` : null,
        result.actualBackend !== backend ? `configured_backend=${backend}, actual_backend=${result.actualBackend ?? "unknown"}` : null,
      ].filter((item):item is string => item !== null);
      const state = mismatches.length ? "blocked" : result.verdict === "passed" ? "passed" : result.verdict === "failed" ? "failed" : "blocked";
      const reason = mismatches.length ? `browser_qa_runtime_setting_mismatch:${mismatches.join("; ")}` : result.reason ?? undefined;
      recordStage(db,{...base,state,providerId:base.providerId,model:result.actualModel ?? model,result,reason});
      return {runId:args.runId,taskId:args.taskId,state,stage:listStageReceipts(db,args.runId,args.taskId).find((row) => row.stageId === "browser-qa"),result,reason};
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      recordStage(db,{...base,state:"failed",reason});
      return {runId:args.runId,taskId:args.taskId,state:"failed",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
  }

  async function startCancelProbe(projectId: string, pmThreadId: string): Promise<Record<string,unknown>> {
    const config = loadPrototypeConfig(db, projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${projectId}`);
    const runId = id("lpcancelrun");
    const taskId = id("lpcanceltask");
    const attemptId = id("lpcancelattempt");
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    createAttempt(db, { id:attemptId, runId, taskId });
    transitionAttempt(db, attemptId, "spawn_requested");
    try {
      const spawned = await bb.sdk.threads.spawn({
        projectId,
        providerId:config.writerProviderId,
        model:config.writerModel,
        prompt:"Lane Pilot cancel probe. Run `sleep 300` using Bash before responding. Do not edit any file.",
        environment:{ type:"host", hostId:config.hostId, workspace:{ type:"unmanaged", path:config.writerWorkspacePath } },
        visibility:"hidden",
        pluginMetadata:{ role:"writer", lanePilotRunId:runId, lanePilotTaskId:taskId, attemptId, parentPmThreadId:pmThreadId },
        executionInputSources:{ providerId:"explicit", model:"explicit" },
      });
      const threadId = stringAt(spawned, "id");
      if (!threadId) throw new Error("threads.spawn returned no cancel-probe thread id");
      transitionAttempt(db, attemptId, "running", { threadId });
      return { runId, taskId, attemptId, threadId, state:"running" };
    } catch (cause) {
      transitionAttempt(db, attemptId, "spawn_rejected", { reason:cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    }
  }

  async function startProviderErrorProbe(projectId: string, pmThreadId: string): Promise<Record<string,unknown>> {
    const config = loadPrototypeConfig(db, projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${projectId}`);
    const runId = id("lperrorrun");
    const taskId = id("lperrortask");
    const attemptId = id("lperrorattempt");
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    createAttempt(db, { id:attemptId, runId, taskId });
    transitionAttempt(db, attemptId, "spawn_requested");
    const spawned = await bb.sdk.threads.spawn({
      projectId,
      providerId:config.writerProviderId,
      model:"__lane_pilot_missing_model__",
      prompt:"Lane Pilot provider-error probe. Reply only ok.",
      environment:{ type:"host", hostId:config.hostId, workspace:{ type:"unmanaged", path:config.writerWorkspacePath } },
      visibility:"hidden",
      pluginMetadata:{ role:"writer", lanePilotRunId:runId, lanePilotTaskId:taskId, attemptId, parentPmThreadId:pmThreadId },
      executionInputSources:{ providerId:"explicit", model:"explicit" },
    });
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("threads.spawn returned no provider-error probe thread id");
    transitionAttempt(db, attemptId, "running", { threadId });
    const observed = await bb.sdk.threads.wait({ threadId, status:"error", timeoutMs:60_000 });
    const observedThread = valueAt(observed, "thread");
    if (stringAt(observedThread, "status") !== "error") throw new Error("provider-error probe did not observe error status");
    transitionAttempt(db, attemptId, "provider_error", { threadId, reason:"observed provider error from deliberately missing model" });
    await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
    await bb.sdk.threads.archive({ threadId }).catch(() => undefined);
    return { runId, taskId, attemptId, threadId, observedStatus:"error", state:"provider_error" };
  }

  async function startAmbiguousProbe(projectId: string, pmThreadId: string): Promise<Record<string,unknown>> {
    const config = loadPrototypeConfig(db, projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${projectId}`);
    const runId = id("lpambiguousrun");
    const taskId = id("lpambiguoustask");
    const attemptId = id("lpambiguousattempt");
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    createAttempt(db, { id:attemptId, runId, taskId });
    transitionAttempt(db, attemptId, "spawn_unknown", { reason:"live ambiguous reconcile probe" });
    const threadIds: string[] = [];
    try {
      for (const ordinal of [1, 2]) {
        const spawned = await bb.sdk.threads.spawn({
          projectId,
          providerId:config.writerProviderId,
          model:config.writerModel,
          prompt:`Lane Pilot ambiguous reconcile probe ${ordinal}.`,
          sendAt:Date.now() + 86_400_000,
          environment:{ type:"host", hostId:config.hostId, workspace:{ type:"unmanaged", path:config.writerWorkspacePath } },
          visibility:"hidden",
          pluginMetadata:{ role:"ambiguous-probe", probeOrdinal:ordinal },
          executionInputSources:{ providerId:"explicit", model:"explicit" },
        });
        const threadId = stringAt(spawned, "id");
        if (!threadId) throw new Error("threads.spawn returned no ambiguous-probe thread id");
        threadIds.push(threadId);
      }
      for (const threadId of threadIds) {
        await bb.sdk.threads.updatePluginMetadata({
          threadId,
          set:{ role:"writer", lanePilotRunId:runId, lanePilotTaskId:taskId, attemptId, parentPmThreadId:pmThreadId },
          remove:["probeOrdinal"],
        });
      }
      let reconcileError = "";
      try {
        const attempt = getAttempt(db, attemptId);
        if (!attempt) throw new Error("ambiguous probe attempt disappeared");
        await reconcileAttemptThread(projectId, attempt);
      } catch (cause) {
        reconcileError = cause instanceof Error ? cause.message : String(cause);
      }
      const persisted = getAttempt(db, attemptId);
      if (persisted?.state !== "blocked" || persisted.thread_id !== null) {
        throw new Error(`ambiguous reconcile did not fail closed: ${JSON.stringify(persisted)}`);
      }
      return {
        runId, taskId, attemptId, threadIds,
        metadataUpdated:true,
        reconcileError,
        state:persisted.state,
        reason:"reconcile_ambiguous",
      };
    } finally {
      for (const threadId of threadIds) {
        await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
        await bb.sdk.threads.delete({ threadId, childThreadsConfirmed:true }).catch(() => undefined);
      }
    }
  }

  bb.rpc.register(rpcContract, {
    get_preferences: async ({ suggestedLocale }) => {
      const storedLocale = await bb.storage.kv.get<string>("preferences:locale");
      const lastProjectId = await bb.storage.kv.get<string>("preferences:lastProjectId");
      const preference: "auto" | "en" | "ru" = storedLocale === "ru" || storedLocale === "en" ? storedLocale : "auto";
      const resolvedLocale: "en" | "ru" = preference === "auto" ? suggestedLocale : preference;
      if (storedLocale !== preference) await bb.storage.kv.set("preferences:locale", preference);
      return { locale: resolvedLocale, preference, lastProjectId: lastProjectId ?? null };
    },
    set_locale: async ({ locale: preference, suggestedLocale }) => {
      await bb.storage.kv.set("preferences:locale", preference);
      const locale = preference === "auto" ? suggestedLocale : preference;
      return { locale, preference };
    },
    remember_project: async ({ projectId }) => {
      await bb.storage.kv.set("preferences:lastProjectId", projectId);
      return { ok: true as const };
    },
    list_projects: async () => {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        projects: projects.map(({ id, name }) => ({ id, name })),
        lastProjectId: await bb.storage.kv.get<string>("preferences:lastProjectId") ?? null,
      };
    },
    finish_run: async ({ projectId, runId }) => {
      await finishRunSafely(bb, db, projectId, runId, "rpc");
      return { projectId, finishedRunIds: [runId], closed: true };
    },
    activate_pm: ({ projectId, sourceThreadId }) => {
      if (!sourceThreadId) throw new Error("Open an ordinary thread before enabling Lane Pilot");
      return activate(projectId, sourceThreadId);
    },
    get_screen: ({ projectId }) => {
      const config = loadPrototypeConfig(db, projectId);
      const settings = loadProjectSettings(db, projectId);
      const rows = listSettingRows(db, projectId);
      const values: Record<string, unknown> = {};
      const versions: Record<string, number> = {};
      for (const row of rows) {
        values[row.key] = row.value;
        versions[row.key] = row.version;
      }
      for (const row of VISIBLE_CATALOG) {
        if (!(row.storageKey in values)) {
          if (row.storageKey === "jev.LANE_JEV_EFFORT" || row.storageKey === "jev.LANE_OPENCODE_JEV") {
            values[row.storageKey] = "1";
          }
        }
      }
      values["plan_critique.enabled"] ??= true;
      values["plan_critique.mode"] ??= "gate";
      if (config) {
        values["writer.provider"] ??= settings["writer.provider"] ?? config.writerProviderId;
        values["writer.model"] ??= settings["writer.model"] ?? config.writerModel;
      }
      values["writer.reasoning_effort"] ??= settings["writer.reasoning_effort"] ?? "medium";
      values["writer.service_tier"] ??= writerServiceTier(settings);
      const completed = values["import.completed"];
      const routing = values["import.routing_profile"];
      const night = values["import.night_shift"];
      const invocation = buildCliInvocation({
        binary: "run-controller",
        subcommand: "run",
        settings: config ? cliSettingsFor(projectId, config) : settings,
      });
      const unapplied = invocation.unapplied.map((item) => ({ key: item.key, reason: item.reason }));
      const listed = listRunsWithAttempts(db, projectId).map((run) => {
        const runReceipt = asJsonText(values[cliReceiptRunKey(run.id)]);
        return {
          id:run.id,
          state: run.closed_at ? "closed" : run.state,
          kind:run.kind,
          created_at:run.created_at,
          updated_at:run.updated_at,
          cliReceiptJson: runReceipt,
          stages:listStageReceipts(db, run.id),
          attempts: run.attempts.map((attempt) => ({
            ...attempt,
            cliReceiptJson: asJsonText(values[cliReceiptAttemptKey(attempt.id)]),
          })),
        };
      });
      const latestReceipt = listed
        .flatMap((run) => [
          ...run.attempts.map((attempt) => attempt.cliReceiptJson),
          run.cliReceiptJson,
        ])
        .find((text) => text != null) ?? null;
      return {
        projectId,
        hostId: config?.hostId ?? null,
        workspacePath: config?.writerWorkspacePath ?? null,
        values,
        versions,
        importSource: {
          completed: Boolean(completed),
          at: completed && typeof completed === "object" && completed && "at" in completed
            ? Number((completed as { at?: number }).at ?? null)
            : null,
          routingPath: routing && typeof routing === "object" && routing && "path" in routing
            ? String((routing as { path?: string }).path ?? "") || null
            : null,
          nightPath: night && typeof night === "object" && night && "path" in night
            ? String((night as { path?: string }).path ?? "") || null
            : null,
        },
        runs: listed,
        unapplied,
        cliPreview: {
          argv: invocation.argv,
          env: invocation.env,
          applied: invocation.applied,
          unapplied,
        },
        lastSnapshotPath: typeof values["install.lastSnapshotPath"] === "string" ? values["install.lastSnapshotPath"] as string : null,
        lastReceiptJson: asJsonText(values["install.lastReceipt"]),
        writerResultJson: asJsonText(values["writer.lastResult"]),
        writerResultPatch: asJsonText(values["writer.lastPatch"]),
        cliReceiptJson: latestReceipt,
      };
    },
    save_setting: ({ projectId, key, value, expectedVersion }) => {
      if (!NATIVE_WRITER_KEYS.has(key)) {
        const result = casUpsertSettings(db, { projectId, changes:[{ key, value, expectedVersion }] }, { nativeWriterSelection:true });
        const current = { version:result.versions[key] ?? 0, value:result.values[key] ?? null };
        if (!result.ok) {
          if (result.validation) return { ok:false, conflict:false, ...current, validation:result.validation };
          return { ok:false, conflict:true, ...current };
        }
        return { ok:true, conflict:false, version:current.version, value };
      }
      const result = casUpsertSetting(db, { projectId, key, value, expectedVersion });
      if (!result.ok) {
        if ("validation" in result) return result;
        return { ok: false, conflict: true, version: result.version, value: result.value };
      }
      return { ok: true, conflict: false, version: result.version, value };
    },
    save_settings: ({ projectId, changes }) => casUpsertSettings(db, { projectId, changes }, {
      nativeWriterSelection: changes.every(({ key }) => !NATIVE_WRITER_KEYS.has(key)),
    }),
    save_writer_selection: async ({ projectId, providerId, model: modelId, reasoningLevel, serviceTier, expectedVersions }) => {
      const reject = (code:"invalid_choice"|"incompatible_setting", key:string, message:string) => ({
        ok:false, conflict:false, values:{}, versions:{}, validation:{ code, key, params:[key, message] },
      });
      const config = loadPrototypeConfig(db, projectId);
      if (!config) return reject("invalid_choice", "writer.provider", "project has no configured writer host");
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>;
      let catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {
        [providers, catalog] = await Promise.all([
          bb.sdk.providers.list({ hostId:config.hostId }),
          bb.sdk.providers.models({ providerId, hostId:config.hostId }),
        ]);
      } catch {
        return reject("invalid_choice", "writer.provider", "the live provider catalog for this host is unavailable");
      }
      const provider = providers.find((item) => item.id === providerId && item.available);
      if (!provider) return reject("invalid_choice", "writer.provider", `provider ${providerId} is unavailable on this host`);
      const selectedModel = catalog.models.find((item) => item.id === modelId || item.model === modelId);
      if (!selectedModel) return reject("invalid_choice", "writer.model", `model ${modelId} is not in the live catalog for ${providerId}`);
      const supportedEfforts = selectedModel.supportedReasoningEfforts.map((item) => item.reasoningEffort);
      if (!supportedEfforts.includes(reasoningLevel)) {
        return reject("incompatible_setting", "writer.reasoning_effort", `model supports: ${supportedEfforts.join(", ")}`);
      }
      const supportedTiers = provider.serviceTiers?.map((tier) => tier.id) ?? [];
      const selectedTier = serviceTier ?? (provider.capabilities.supportsServiceTier && supportedTiers.includes("default") ? "default" : null);
      if (selectedTier && !supportedTiers.includes(selectedTier)) {
        return reject("invalid_choice", "writer.service_tier", `provider supports: ${supportedTiers.join(", ") || "no service tiers"}`);
      }
      return casUpsertSettings(db, {
        projectId,
        changes:[
          { key:"writer.provider", value:providerId, expectedVersion:expectedVersions["writer.provider"] },
          { key:"writer.model", value:modelId, expectedVersion:expectedVersions["writer.model"] },
          { key:"writer.reasoning_effort", value:reasoningLevel, expectedVersion:expectedVersions["writer.reasoning_effort"] },
          { key:"writer.service_tier", value:selectedTier === "fast" ? "fast" : "standard", expectedVersion:expectedVersions["writer.service_tier"] },
        ],
      }, { nativeWriterSelection:true });
    },
    cancel_attempt: async ({ attemptId }) => {
      const attempt = getAttempt(db, attemptId);
      if (!attempt?.thread_id) return { ok: false, state: attempt?.state ?? "missing", reason: "attempt has no writer thread" };
      const rejection = cancelRejection(db, attempt);
      if (rejection) return { ok:false, state:attempt.state, reason:rejection };
      transitionAttempt(db, attempt.id, "cancel_requested", { threadId: attempt.thread_id });
      await bb.sdk.threads.stop({ threadId: attempt.thread_id });
      const observed = await bb.sdk.threads.get({ threadId: attempt.thread_id });
      const status = stringAt(observed, "status");
      const listRunning = (bb.sdk.threads as { listRunning?: (query?: Record<string, unknown>) => Promise<Array<{ id: string }>> }).listRunning;
      const running = listRunning ? await listRunning({}) : [];
      const stillRunning = running.some((thread) => thread.id === attempt.thread_id)
        || status === "active" || status === "running";
      if (stillRunning) return { ok: false, state: "cancel_requested", reason: `writer stop was not independently observed (status=${status ?? "unknown"})` };
      transitionAttempt(db, attempt.id, "canceled", { threadId: attempt.thread_id });
      const task = getTask(db, attempt.task_id);
      const plan = getTaskPlan(db, attempt.task_id) ?? (task?.kind === "bb" ? valueAt(task.contract, "objective") : "") as string;
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        const current = listStageReceipts(db, attempt.run_id, attempt.task_id).find((row) => row.stageId === stageId);
        if (current && (current.state === "pending" || current.state === "running")) {
          recordStage(db, { runId:attempt.run_id, taskId:attempt.task_id, stageId, state:"canceled", input:plan,
            attempt:attempt.attempt_no, threadId:attempt.thread_id, reason:"writer stop observed" });
        }
      }
      return { ok: true, state: "canceled", reason: null };
    },
    retry_attempt: ({ attemptId }) => {
      const attempt = getAttempt(db, attemptId);
      if (!attempt) return { ok: false, state: "missing", attemptId, reason: "attempt does not exist" };
      const used = countAttempts(db, attempt.run_id, attempt.task_id);
      if (!RETRY_ELIGIBLE.includes(attempt.state as AttemptState)) {
        return { ok: false, state: attempt.state, attemptId, reason: `retry is not legal from ${attempt.state}` };
      }
      if (used >= MAIN_ATTEMPT_LIMIT) {
        transitionAttempt(db, attempt.id, "blocked", { reason: "retry limit 2 exhausted" });
        return { ok: false, state: "blocked", attemptId, reason: "retry limit 2 exhausted" };
      }
      const nextId = id("lpattempt");
      createAttempt(db, { id: nextId, runId: attempt.run_id, taskId: attempt.task_id });
      return { ok: true, state: "queued", attemptId: nextId, reason: null };
    },
    resume_runs: ({ projectId }) => resumeOrphans(projectId),
    stack_detect: async ({ projectId }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      const [stack, coexistence] = await Promise.all([
        host.call("detect", { requestedHostId: config.hostId, workspacePath: config.writerWorkspacePath }, { hostId: config.hostId }),
        host.call("coexistenceInventory", { requestedHostId: config.hostId, projectId }, { hostId: config.hostId }),
      ]);
      return { ...stack, coexistence };
    },
    stack_install: async ({ projectId, confirmExternalOps }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      if (!confirmExternalOps) return { schemaVersion:1, action:"install", status:"blocked", reason:"Explicit installation confirmation is required; no operation was run." };
      const inventory = await coexistenceInventory(projectId, config.hostId);
      const manager = inventory.managers.find((row) => row.manager === "managed-checkout");
      if (!manager) throw new Error("Read-only inventory did not return the managed-checkout manager");
      const receipt = await coexistenceOperation({
        projectId, hostId:config.hostId, operation:"install", manager:"managed-checkout", path:manager.path,
        expectedSha256:manager.sha256, targetSha:inventory.targetSha,
      });
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
    stack_connect: async ({ projectId, confirmExternalOps }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      if (!confirmExternalOps) return { schemaVersion:1, action:"connect", status:"blocked", reason:"Explicit OpenCode connection confirmation is required; no operation was run." };
      const initial = await coexistenceInventory(projectId, config.hostId);
      const plugin = initial.managers.find((row) => row.manager === "opencode-plugin");
      const configRow = initial.managers.find((row) => row.manager === "opencode-config");
      if (!plugin || !configRow) throw new Error("Read-only inventory did not return the OpenCode plugin and config managers");
      const operations = [];
      const installed = await coexistenceOperation({
        projectId, hostId:config.hostId, operation:"install", manager:"opencode-plugin", path:plugin.path,
        expectedSha256:plugin.sha256, targetSha:initial.targetSha,
      });
      operations.push(installed);
      if (!(installed.status === "ok" || installed.status === "skipped")) {
        const receipt = { schemaVersion:1, action:"connect", status:installed.status, coexistenceOperations:operations };
        saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
        return receipt;
      }
      const current = await coexistenceInventory(projectId, config.hostId);
      const currentConfig = current.managers.find((row) => row.manager === "opencode-config" && row.path === configRow.path);
      if (!currentConfig) throw new Error("OpenCode configuration disappeared after plugin installation; no connection write was attempted");
      const connected = await coexistenceOperation({
        projectId, hostId:config.hostId, operation:"connect", manager:"opencode-config", path:currentConfig.path,
        expectedSha256:currentConfig.sha256, targetSha:current.targetSha,
      });
      operations.push(connected);
      const receipt = { schemaVersion:1, action:"connect", status:connected.status, coexistenceOperations:operations };
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
    stack_rollback: async ({ projectId, snapshotPath }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      const saved = loadProjectSettings(db, projectId)["install.lastReceipt"];
      let parsed: Record<string, unknown> | null = null;
      try {
        const value: unknown = JSON.parse(typeof saved === "string" ? saved : "");
        if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
      } catch { /* older installation receipt */ }
      const operations = Array.isArray(parsed?.coexistenceOperations)
        ? parsed.coexistenceOperations.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : parsed && typeof parsed.manager === "string" && typeof parsed.path === "string" && typeof parsed.snapshotId === "string" ? [parsed] : [];
      if (operations.length) {
        const rolledBack: unknown[] = [];
        for (const previous of [...operations].reverse()) {
          if (typeof previous.manager !== "string" || typeof previous.path !== "string" || typeof previous.snapshotId !== "string") continue;
          const inventory = await coexistenceInventory(projectId, config.hostId);
          const row = inventory.managers.find((manager) => manager.manager === previous.manager && manager.path === previous.path);
          if (!row) {
            rolledBack.push({ manager:previous.manager, path:previous.path, status:"conflict", reason:"Owned manager/path is no longer in the current inventory; no arbitrary path rollback was attempted." });
            break;
          }
          const receipt = await coexistenceOperation({
            projectId, hostId:config.hostId, operation:"rollback", manager:previous.manager as "agents-marker"|"managed-checkout"|"claude-cache"|"claude-settings"|"opencode-config"|"opencode-plugin",
            path:previous.path, expectedSha256:row.sha256, snapshotId:previous.snapshotId, targetSha:inventory.targetSha,
          });
          rolledBack.push(receipt);
          if (!(receipt.status === "ok" || receipt.status === "rolled_back" || receipt.status === "skipped")) break;
        }
        const receipt = { schemaVersion:1, action:"rollback", status:rolledBack.every((item) => Boolean(item && typeof item === "object" && "status" in item && ["ok", "rolled_back", "skipped"].includes(String(item.status)))) ? "rolled_back" : "conflict", results:rolledBack };
        if (receipt.status === "rolled_back") saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
        else saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify({ ...parsed, lastRollbackAttempt:receipt }));
        return receipt;
      }
      if (!snapshotPath) throw new Error("No Lane Pilot coexistence snapshot is available and no legacy snapshot path was supplied.");
      const receipt = await host.call("rollback", {
        requestedHostId: config.hostId,
        snapshotPath,
      }, { hostId: config.hostId, timeoutMs: 180_000 });
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
  });

  bb.agents.registerTool({
    name:"lane_pilot_dispatch_writer",
    description:"Start a task-v2 contract with the configured native BB writer and return run/attempt identity immediately.",
    instructions:"Use only from a Lane Pilot PM thread. Returns before writer completion. Then call lane_pilot_wait_writer with the returned runId; if it reports still running, call it again. Persists identity before spawn, retries at most twice, never falls back to Codex.",
    parameters:z.object({ confirm:z.literal(true), plan:z.string().min(1), task:taskV2Schema.optional() }).strict(),
    execute: async (params, context) => JSON.stringify(
      await dispatchWriter({ threadId:context.threadId, projectId:context.projectId, task:params.task, plan:params.plan }),
      null,
      2,
    ),
  });
  bb.agents.registerTool({
    name:"lane_pilot_wait_writer",
    description:"Wait up to 240 seconds for a Lane Pilot writer run and return its persisted receipt or running state.",
    instructions:"Use only from the same Lane Pilot PM thread that dispatched the run. If state is running, call again with the same runId.",
    parameters:z.object({ runId:z.string().min(1), timeoutSec:z.number().int().min(1).max(240).default(60) }).strict(),
    execute: async (params, context) => JSON.stringify(
      await waitWriter({ threadId:context.threadId, projectId:context.projectId, runId:params.runId, timeoutSec:params.timeoutSec }),
      null,
      2,
    ),
  });
  bb.agents.registerTool({
    name:"lane_pilot_dispatch_cli",
    description:"Dispatch a CLI writer through run-controller or lane-ctl on the project host worker.",
    instructions:"Use only from a Lane Pilot PM thread. Do not mix with a BB writer run. Receipt lists settings that have no runtime channel.",
    parameters:z.object({
      confirm:z.literal(true),
      binary:z.enum(["run-controller","lane-ctl"]).optional(),
      subcommand:z.string().min(1).optional(),
      taskFile:z.string().min(1).optional(),
      taskId:z.string().min(1).optional(),
    }).strict(),
    execute: async (params, context) => JSON.stringify(
      await dispatchCli({
        threadId:context.threadId,
        projectId:context.projectId,
        binary:params.binary,
        subcommand:params.subcommand,
        taskFile:params.taskFile,
        taskId:params.taskId,
      }),
      null,
      2,
    ),
  });
  bb.agents.registerTool({
    name:"lane_pilot_browser_qa",
    description:"Run configured live browser QA against an accepted task workspace and return its report and screenshot receipts.",
    instructions:"Use only from the matching Lane Pilot PM thread and only after lane_pilot_wait_writer returned an accepted receipt. Supply concrete browser-ui cases and the exact target URL. Production, unknown, or stateful side-effect cases require authorized=true. A report without a complete all-passed summary is never reported as passed.",
    parameters:z.object({
      runId:z.string().min(1), taskId:z.string().min(1), url:z.string().url(),
      cases:z.array(z.string().min(1).max(2000)).min(1).max(30),
      envClass:z.enum(["local","staging","preview","production","unknown"]),
      viewports:z.string().regex(/^\d{2,4}(,\d{2,4}){0,2}$/).default("375,768,1280"),
      authorized:z.boolean().default(false),
    }).strict(),
    execute:async (params,context) => JSON.stringify(await runBrowserQa({
      threadId:context.threadId, projectId:context.projectId, runId:params.runId, taskId:params.taskId,
      url:params.url, cases:params.cases, envClass:params.envClass, viewports:params.viewports, authorized:params.authorized,
    }),null,2),
  });

  bb.agents.configure((context) => {
    const role = context.pluginMetadata.role;
    const runId = context.pluginMetadata.lanePilotRunId;
    if (context.origin.pluginId !== "lane-pilot" || role !== "pm" || typeof runId !== "string") return { tools:[], skills:[] };
    const config = loadPrototypeConfig(db, context.project.id);
    return {
      tools:["lane_pilot_dispatch_writer","lane_pilot_wait_writer","lane_pilot_dispatch_cli","lane_pilot_browser_qa"],
      skills:[],
      instructions:config
        ? `Lane Pilot PM ${runId}. Writer=${config.writerProviderId}/${config.writerModel}; writer workspace=${config.writerWorkspacePath}. Every task-v2 project_cwd must equal this writer workspace; a mismatch is rejected before dispatch. The workspace is fixed for this run even if project settings change later. The writer tool is available only in this PM thread. To delegate: supply the complete canonical plan in the separate plan parameter of lane_pilot_dispatch_writer and the task-v2 contract in task; never put wrapper/system instructions into plan. Then immediately note its runId/attemptId; call lane_pilot_wait_writer with that runId (timeoutSec up to 240), repeating while running. Return the final receipt to the user verbatim.`
        : `Lane Pilot PM ${runId}, but project configuration is missing.`,
    };
  });

  const usage = [
    "bb lane-pilot configure <json>",
    "bb lane-pilot activate <project-id> <ordinary-source-thread-id>",
    "bb lane-pilot state <project-id>",
    "bb lane-pilot finish <project-id>",
    "bb lane-pilot deactivate <project-id>",
    "bb lane-pilot cancel <attempt-id>",
    "bb lane-pilot recover <attempt-id>",
    "bb lane-pilot start-cancel-probe <project-id> <pm-thread-id>",
    "bb lane-pilot start-provider-error-probe <project-id> <pm-thread-id>",
    "bb lane-pilot start-ambiguous-probe <project-id> <pm-thread-id>",
    "bb lane-pilot host-detect <host-id> <workspace-path>",
    "bb lane-pilot host-snapshot <host-id> <absolute-path>...",
    "bb lane-pilot host-snapshot-manifest <host-id> [thread-storage]",
    "bb lane-pilot host-install <host-id> [thread-storage] [pm-workspace]",
    "bb lane-pilot host-rollback <host-id> <snapshot-path>",
    "bb lane-pilot host-connect-opencode <host-id>",
    "bb lane-pilot host-import-config <host-id> <project-id> [workspace-path]",
    "bb lane-pilot host-run-cli <host-id> <cwd> <binary> <subcommand> [args...]",
    "bb lane-pilot resume [project-id]",
    "bb lane-pilot dispatch-cli <project-id> <pm-thread-id> [binary] [subcommand] [task-file] [task-id] [run-dir]",
    "bb lane-pilot dispatch-bb <project-id> <pm-thread-id> [task-json]",
  ].join("\n");
  bb.cli.register({
    name:"lane-pilot",
    summary:"Lane Pilot stage-0 prototype controls",
    commands:[
      { name:"configure", summary:"Save prototype project settings", usage:"bb lane-pilot configure '<json>'" },
      { name:"activate", summary:"Spawn a visible isolated PM thread", usage:"bb lane-pilot activate <project-id> <ordinary-source-thread-id>" },
      { name:"state", summary:"Inspect persisted stage-0 state", usage:"bb lane-pilot state <project-id>" },
      { name:"finish", summary:"Close a PM run after observing it idle and release activation", usage:"bb lane-pilot finish <project-id> [run-id]" },
      { name:"deactivate", summary:"Alias for finish", usage:"bb lane-pilot deactivate <project-id> [run-id]" },
      { name:"cancel", summary:"Stop a writer and persist canceled after observing idle", usage:"bb lane-pilot cancel <attempt-id>" },
      { name:"recover", summary:"Reconcile a known writer identity and emit its validated receipt", usage:"bb lane-pilot recover <attempt-id>" },
      { name:"start-cancel-probe", summary:"Spawn a long-running writer for a live stop observation", usage:"bb lane-pilot start-cancel-probe <project-id> <pm-thread-id>" },
      { name:"start-provider-error-probe", summary:"Observe a live provider error and persist provider_error", usage:"bb lane-pilot start-provider-error-probe <project-id> <pm-thread-id>" },
      { name:"start-ambiguous-probe", summary:"Create duplicate metadata and prove reconcile blocks", usage:"bb lane-pilot start-ambiguous-probe <project-id> <pm-thread-id>" },
      { name:"host-detect", summary:"Call the host worker detect method", usage:"bb lane-pilot host-detect <host-id> <workspace-path>" },
      { name:"host-snapshot", summary:"Call read-only snapshotDryRun", usage:"bb lane-pilot host-snapshot <host-id> <absolute-path>..." },
      { name:"host-snapshot-manifest", summary:"Full §11.1 snapshot", usage:"bb lane-pilot host-snapshot-manifest <host-id> [thread-storage]" },
      { name:"host-install", summary:"Install target SHA without external ops", usage:"bb lane-pilot host-install <host-id> [thread-storage] [pm-workspace]" },
      { name:"host-rollback", summary:"Rollback a snapshot", usage:"bb lane-pilot host-rollback <host-id> <snapshot-path>" },
      { name:"host-connect-opencode", summary:"S5 JSONC plugin patch", usage:"bb lane-pilot host-connect-opencode <host-id>" },
      { name:"host-import-config", summary:"S7 one-shot YAML read", usage:"bb lane-pilot host-import-config <host-id> <project-id> [workspace-path]" },
      { name:"host-run-cli", summary:"Run run-controller/lane-ctl on the project host", usage:"bb lane-pilot host-run-cli <host-id> <cwd> <binary> <subcommand> [args...]" },
      { name:"resume", summary:"Reconcile orphaned writer attempts without spawning duplicates", usage:"bb lane-pilot resume [project-id]" },
      { name:"dispatch-cli", summary:"Dispatch a CLI writer run for a PM thread", usage:"bb lane-pilot dispatch-cli <project-id> <pm-thread-id> [binary] [subcommand]" },
      { name:"dispatch-bb", summary:"Dispatch a BB writer task, optional task-v2 JSON", usage:"bb lane-pilot dispatch-bb <project-id> <pm-thread-id> [task-json]" },
    ],
    async run(argv) {
      try {
        const [command, ...args] = argv;
        if (command === "configure" && args.length === 1) {
          const config = prototypeConfigSchema.parse(JSON.parse(args[0]!));
          savePrototypeConfig(db, config);
          return { exitCode:0, stdout:JSON.stringify({ ok:true, projectId:config.projectId }) };
        }
        if (command === "activate" && args.length >= 2) {
          return { exitCode:0, stdout:JSON.stringify(await activate(args[0]!, args[1]!, args[2] === "cli" ? "cli" : "bb")) };
        }
        if (command === "state" && args.length === 1) {
          return { exitCode:0, stdout:JSON.stringify(inspectState(db, args[0]!), null, 2) };
        }
        if ((command === "finish" || command === "deactivate") && (args.length === 1 || args.length === 2)) {
          const projectId = args[0]!;
          const runs = listRunsWithAttempts(db, projectId).filter((run) => !run.closed_at);
          const activation = getActivation(db, projectId);
          const runId = args[1] ?? (activation?.run_id && runs.some((run) => run.id === activation.run_id)
            ? activation.run_id
            : runs.length === 1 ? runs[0]!.id : null);
          if (!runId) {
            if (!runs.length) return { exitCode:0, stdout:JSON.stringify({ projectId, finishedRunIds:[], closed:true }) };
            throw new Error("specify a run id when the project has multiple open runs");
          }
          await finishRunSafely(bb, db, projectId, runId, "cli");
          return { exitCode:0, stdout:JSON.stringify({ projectId, finishedRunIds:[runId], closed:true }) };
        }
        if (command === "cancel" && args.length === 1) {
          const attempt = getAttempt(db, args[0]!);
          if (!attempt?.thread_id) throw new Error("attempt has no writer thread");
          const rejection = cancelRejection(db, attempt);
          if (rejection) return { exitCode:1, stdout:JSON.stringify({ ok:false, attemptId:attempt.id, state:attempt.state, reason:rejection }) };
          transitionAttempt(db, attempt.id, "cancel_requested", { threadId:attempt.thread_id });
          await bb.sdk.threads.stop({ threadId:attempt.thread_id });
          const observed = await bb.sdk.threads.get({ threadId:attempt.thread_id });
          const status = stringAt(observed, "status");
          const listRunning = (bb.sdk.threads as { listRunning?: (query?: Record<string, unknown>) => Promise<Array<{id:string}>> }).listRunning;
          const running = listRunning ? await listRunning({}) : [];
          const stillRunning = running.some((thread) => thread.id === attempt.thread_id)
            || status === "active" || status === "running";
          if (stillRunning) throw new Error(`writer stop was not independently observed (status=${status ?? "unknown"})`);
          transitionAttempt(db, attempt.id, "canceled", { threadId:attempt.thread_id });
          return { exitCode:0, stdout:JSON.stringify({
            ok:true, attemptId:attempt.id, threadId:attempt.thread_id, state:"canceled", observedStatus:status,
          }) };
        }
        if (command === "recover" && args.length === 1) {
          const attempt = getAttempt(db, args[0]!);
          if (!attempt) throw new Error("attempt does not exist");
          const run = getRun(db, attempt.run_id);
          if (!run?.pm_thread_id) throw new Error("attempt run has no PM thread");
          const writerThreadId = await reconcileAttemptThread(run.project_id, attempt);
          const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:writerThreadId });
          if (valueAt(metadata, "lanePilotRunId") !== attempt.run_id
            || valueAt(metadata, "lanePilotTaskId") !== attempt.task_id
            || valueAt(metadata, "attemptId") !== attempt.id) {
            transitionAttempt(db, attempt.id, "blocked", { threadId:writerThreadId, reason:"idempotency triple mismatch" });
            throw new Error("writer metadata does not match the persisted idempotency triple");
          }
          const thread = await bb.sdk.threads.get({ threadId:writerThreadId });
          if (stringAt(thread, "status") !== "idle") throw new Error(`writer is not idle: ${stringAt(thread, "status") ?? "unknown"}`);
          const config = loadPrototypeConfig(db, run.project_id);
          if (!config) throw new Error("prototype configuration is missing");
          const [hello, test, output] = await Promise.all([
            bb.sdk.files.read({ hostId:config.hostId, rootPath:config.writerWorkspacePath, path:`${config.writerWorkspacePath}/hello.txt` }),
            bb.sdk.files.read({ hostId:config.hostId, rootPath:config.writerWorkspacePath, path:`${config.writerWorkspacePath}/tests/hello.test.txt` }),
            bb.sdk.threads.output({ threadId:writerThreadId }),
          ]);
          if (stringAt(hello, "content") !== "hello from native BB writer\n"
            || stringAt(test, "content") !== "hello from native BB writer\n") {
            transitionAttempt(db, attempt.id, "validation_failed", { threadId:writerThreadId, reason:"fixture output content mismatch" });
            throw new Error("reconciled writer output failed validation");
          }
          const savedTask = getTask(db, attempt.task_id);
          if (!savedTask) throw new Error(`reconciled task missing: ${attempt.task_id}`);
          const recoveredTask = taskV2Schema.parse(savedTask.contract);
          const verification = await runVerification(config, recoveredTask);
          if (verification.some((item) => item.exitCode !== 0)) {
            transitionAttempt(db, attempt.id, "validation_failed", { threadId:writerThreadId, reason:"recovered writer verification failed" });
            throw new Error("reconciled writer verification failed");
          }
          const receipt = await persistWriterAcceptance({
            config, task:recoveredTask, runId:attempt.run_id,
            taskId:attempt.task_id, attempt:attempt.attempt_no, attemptId:attempt.id,
            pmThreadId:run.pm_thread_id, writerThreadId, output:outputText(output), verification,
          });
          transitionAttempt(db, attempt.id, "accepted", { threadId:writerThreadId });
          return { exitCode:0, stdout:JSON.stringify(receipt, null, 2) };
        }
        if (command === "start-cancel-probe" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await startCancelProbe(args[0]!, args[1]!), null, 2) };
        }
        if (command === "start-provider-error-probe" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await startProviderErrorProbe(args[0]!, args[1]!), null, 2) };
        }
        if (command === "start-ambiguous-probe" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await startAmbiguousProbe(args[0]!, args[1]!), null, 2) };
        }
        if (command === "host-detect" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("detect", { requestedHostId:args[0]!, workspacePath:args[1]! }, { hostId:args[0]! }), null, 2) };
        }
        if (command === "host-snapshot" && args.length >= 2) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("snapshotDryRun", { requestedHostId:args[0]!, paths:args.slice(1) }, { hostId:args[0]! }), null, 2) };
        }
        if (command === "host-snapshot-manifest" && args.length >= 1) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("snapshot", {
            requestedHostId:args[0]!,
            threadStoragePath:args[1],
          }, { hostId:args[0]!, timeoutMs:120_000 }), null, 2) };
        }
        if (command === "host-install" && args.length >= 1) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("install", {
            requestedHostId:args[0]!,
            threadStoragePath:args[1],
            pmWorkspacePath:args[2],
            confirmExternalOps:false,
          }, { hostId:args[0]!, timeoutMs:600_000 }), null, 2) };
        }
        if (command === "host-rollback" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("rollback", {
            requestedHostId:args[0]!,
            snapshotPath:args[1]!,
          }, { hostId:args[0]!, timeoutMs:180_000 }), null, 2) };
        }
        if (command === "host-connect-opencode" && args.length === 1) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("connectOpencode", {
            requestedHostId:args[0]!,
          }, { hostId:args[0]!, timeoutMs:30_000 }), null, 2) };
        }
        if (command === "host-run-cli" && args.length >= 4) {
          const config = loadPrototypeConfig(db, "unused") ;
          void config;
          return { exitCode:0, stdout:JSON.stringify(await host.call("runCli", {
            requestedHostId:args[0]!,
            cwd:args[1]!,
            binary:args[2] as "run-controller"|"lane-ctl",
            argv:args.slice(3),
            env:{},
          }, { hostId:args[0]!, timeoutMs:180_000 }), null, 2) };
        }
        if (command === "resume") {
          return { exitCode:0, stdout:JSON.stringify(await resumeOrphans(args[0]), null, 2) };
        }
        if (command === "dispatch-cli" && args.length >= 2) {
          return { exitCode:0, stdout:JSON.stringify(await dispatchCli({
            projectId:args[0]!,
            threadId:args[1]!,
            binary:args[2] as "run-controller"|"lane-ctl"|undefined,
            subcommand:args[3],
            taskFile:args[4] || undefined,
            taskId:args[5] || undefined,
            runDir:args[6] || undefined,
          }), null, 2) };
        }
        if (command === "dispatch-bb" && args.length >= 2) {
          const task = args[2] ? taskV2Schema.parse(JSON.parse(args[2])) : undefined;
          return { exitCode:0, stdout:JSON.stringify(await dispatchWriter({
            projectId:args[0]!,
            threadId:args[1]!,
            task,
          }), null, 2) };
        }
        if (command === "host-import-config" && args.length >= 2) {
          const imported = await host.call("importConfig", {
            requestedHostId:args[0]!,
            projectId:args[1]!,
            workspacePath:args[2],
          }, { hostId:args[0]!, timeoutMs:30_000 });
          const persisted = importSettingsOnce(db, args[1]!, imported.imported);
          return { exitCode:0, stdout:JSON.stringify({ ...imported, persisted }, null, 2) };
        }
        return { exitCode:1, stderr:usage };
      } catch (cause) {
        return { exitCode:1, stderr:cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });

  await resumeOrphans().catch((cause) => {
    bb.log.warn(`Lane Pilot resume on start skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
  bb.log.info("Lane Pilot PM-to-writer pipeline loaded");
}
