import { randomUUID } from "node:crypto";
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
import { acceptanceArtifactDir, buildAcceptanceV2, bbWriterReportMarkdown, validateAcceptanceV2 } from "./src/acceptance-v2";
import {
  claimActivation,
  countAttempts,
  createAttempt,
  createRun,
  createTask,
  getActivation,
  getAttempt,
  getRun,
  getTask,
  setAttemptDirtBefore,
  importSettingsOnce,
  inspectState,
  listOpenAttempts,
  listTaskKinds,
  listTaskTerminalStates,
  loadProjectSettings,
  loadPrototypeConfig,
  listSettingRows,
  listRunsWithAttempts,
  casUpsertSetting,
  casUpsertSettings,
  openDatabase,
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
import { SETTING_CATALOG } from "./src/channels";

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
    task.objective,
    "Run the verification commands, then answer with the changed paths and result.",
    JSON.stringify(task, null, 2),
  ].join("\n\n");
}

function pmPrompt(runId: string, config: PrototypeConfig): string {
  return [
    "You are the Lane Pilot PM. Do not write production code yourself.",
    `Run id: ${runId}. The production fixture is ${config.writerWorkspacePath}.`,
    "First use Bash only for read probes: `pwd`, `ls -la`, and `cat fixture/README.md` if available.",
    "Then demonstrate the guard by attempting a production write with Write or Bash redirection; report the denial.",
    "Delegate the safe fixture task with the native tool `lane_pilot_dispatch_writer`.",
    "Return the tool's receipt to the user verbatim. Do not attempt to activate another PM.",
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const db = openDatabase(bb);
  const host = bb.hosts.experimental_client({ contract:hostContract });

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
    if (input.attempt.state !== "running" || !input.writerThreadId) return false;
    const thread = await bb.sdk.threads.get({ threadId:input.writerThreadId }).catch(() => null);
    const status = stringAt(thread, "status");
    if (status !== "idle" && status !== "error") return false;
    const run = getRun(db, input.attempt.run_id);
    const stored = getTask(db, input.attempt.task_id);
    const config = loadPrototypeConfig(db, input.projectId);
    if (!run || !config || stored?.kind !== "bb") return false;
    const parsed = taskV2Schema.safeParse(stored.contract);
    if (!parsed.success) return false;
    await finishWriterAttempt({
      projectId:input.projectId,
      config,
      task:parsed.data,
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
      "writer.service_tier": stored["writer.service_tier"],
      "writer.fast_mode": stored["writer.fast_mode"],
      "jev.LANE_JEV_EFFORT": stored["jev.LANE_JEV_EFFORT"] ?? true,
      "jev.LANE_OPENCODE_JEV": stored["jev.LANE_OPENCODE_JEV"] ?? true,
      "ops.max_tasks": stored["ops.max_tasks"],
      "ops.poll_interval": stored["ops.poll_interval"],
      "ops.heartbeat_interval": stored["ops.heartbeat_interval"],
      "ops.retry_backoff": stored["ops.retry_backoff"],
      "ops.run_dir": stored["ops.run_dir"],
      "ops.project_cwd": stored["ops.project_cwd"] ?? config.writerWorkspacePath,
      "plan_critique.mode": stored["plan_critique.mode"] ?? "advisory",
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
    if (!detected.matchesTarget || detected.laneStack.sourceSha !== TARGET_SHA) {
      throw new Error(`Lane Pilot PM requires detect S1: ~/.agents/install.json.source_sha must be ${TARGET_SHA}`);
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
    createRun(db, runId, projectId, kind);
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
    config:PrototypeConfig; task:TaskV2; pmThreadId:string;
  }): Promise<
    | { ok:true; threadId:string; dirtBefore:import("./src/cli-outcome").DirtSnapshot[] }
    | { ok:false; status:"spawn_rejected"; reason:string; attemptId:string }
  > {
    const dirt = await workspaceDirt(input.config).catch((cause: unknown) => ({
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
      const spawned = await spawnWithSeam(() => bb.sdk.threads.spawn({
        projectId: input.projectId,
        providerId: input.config.writerProviderId,
        model: input.config.writerModel,
        prompt: writerPrompt(input.task),
        environment: {
          type:"host",
          hostId:input.config.hostId,
          workspace:{ type:"unmanaged", path:input.config.writerWorkspacePath },
        },
        visibility:"hidden",
        pluginMetadata:{
          role:"writer",
          lanePilotRunId:input.runId,
          lanePilotTaskId:input.taskId,
          attemptId:input.attemptId,
          parentPmThreadId:input.pmThreadId,
        },
        executionInputSources:{ providerId:"explicit", model:"explicit" },
      }));
      const writerThreadId = stringAt(spawned, "id") ?? "";
      if (!writerThreadId) throw new Error("threads.spawn returned no writer thread id");
      transitionAttempt(db, input.attemptId, "running", { threadId:writerThreadId });
      return { ok:true, threadId:writerThreadId, dirtBefore };
    } catch (cause) {
      transitionAttempt(db, input.attemptId, "spawn_unknown", { reason:cause instanceof Error ? cause.message : String(cause) });
      const attempt = getAttempt(db, input.attemptId);
      if (!attempt) throw new Error(`persisted attempt disappeared after spawn_unknown: ${input.attemptId}`);
      return { ok:true, threadId: await reconcileAttemptThread(input.projectId, attempt), dirtBefore };
    }
  }

  async function workspaceDirt(config: PrototypeConfig): Promise<{ ok:true; paths:string[]; snapshots:DirtSnapshot[] } | { ok:false; reason:string }> {
    const ran = await host.call("runCommand", {
      requestedHostId: config.hostId,
      command: "python3 - <<'PY'\nimport hashlib, json, os, subprocess\nraw = subprocess.run([\"git\", \"status\", \"--porcelain\", \"-z\", \"-uall\"], check=True, stdout=subprocess.PIPE).stdout\nparts = raw.split(bytes([0]))\npaths = []\ni = 0\nwhile i < len(parts) and parts[i]:\n    item = parts[i]\n    i += 1\n    name = item[3:]\n    if not name:\n        raise ValueError(\"empty git path\")\n    paths.append(name)\n    if item[:2] in (b\"R \", b\"C \", b\" R\", b\" C\"):\n        if i >= len(parts) or not parts[i]:\n            raise ValueError(\"missing rename source\")\n        paths.append(parts[i])\n        i += 1\nrows = []\nfor raw_path in sorted(set(paths)):\n    path = os.fsdecode(raw_path)\n    if os.path.isfile(path):\n        with open(path, \"rb\") as stream:\n            digest = hashlib.sha256(stream.read()).hexdigest()\n    elif os.path.lexists(path):\n        raise ValueError(\"dirty path is not regular: \" + path)\n    else:\n        digest = \"\"\n    rows.append({\"path\": path, \"sha256\": digest})\nprint(json.dumps(rows, ensure_ascii=True))\nPY",
      cwd: config.writerWorkspacePath,
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
    attemptId:string; pmThreadId:string; writerThreadId:string; output:string;
  }): Promise<Record<string,unknown>> {
    const reportText = bbWriterReportMarkdown(input.task, input.attempt);
    const acceptance = buildAcceptanceV2({
      task:input.task, attempt:input.attempt, providerId:input.config.writerProviderId,
      model:input.config.writerModel, reportText,
    });
    const validation = validateAcceptanceV2(acceptance);
    if (!validation.ok) throw new Error(`upstream acceptance-v2 rejected generated receipt: ${validation.errors.join("; ")}`);
    const artifactDir = acceptanceArtifactDir(input.config.writerWorkspacePath, input.runId, input.taskId);
    const internalReceipt = {
      schemaVersion:1, status:"accepted", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
      attemptId:input.attemptId, pmThreadId:input.pmThreadId, writerThreadId:input.writerThreadId,
      ownsPaths:input.task.owns_paths, output:input.output,
    };
    for (const [name, content] of [
      ["report.md", reportText],
      ["acceptance.json", `${JSON.stringify(acceptance, null, 2)}\n`],
      ["lane-pilot-receipt.json", `${JSON.stringify(internalReceipt, null, 2)}\n`],
    ] as const) {
      await bb.sdk.files.write({
        hostId:input.config.hostId, rootPath:input.config.writerWorkspacePath,
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
  }): Promise<{ status:"accepted"|"empty_output"|"validation_failed"; reason?:string; output:string; produced:string[] }> {
    const output = await bb.sdk.threads.output({ threadId:input.writerThreadId });
    const dirt = await workspaceDirt(input.config);
    if (!dirt.ok) {
      return { status:"validation_failed", reason:dirt.reason, output:outputText(output), produced:[] };
    }
    const unverifiable = input.dirtBefore
      .filter((before) => !before.sha256 && dirt.snapshots.some((after) => after.path === before.path))
      .map((file) => file.path);
    if (unverifiable.length > 0) {
      return {
        status:"validation_failed",
        reason:`cannot compare pre-existing dirty file content: ${unverifiable.join(", ")}`,
        output:outputText(output), produced:[],
      };
    }
    const produced = attemptProduced(dirt.snapshots, input.dirtBefore);
    const contents: Record<string, string | null> = {};
    for (const rel of new Set([...input.task.expected_outputs, ...produced])) {
      const absolute = rel.startsWith("/") ? rel : `${input.config.writerWorkspacePath}/${rel}`;
      const read = await bb.sdk.files.read({
        hostId:input.config.hostId,
        rootPath:input.config.writerWorkspacePath,
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
          produced,
        };
      }
    }
    if (!classified.ok) {
      return { status:classified.state, reason:classified.reason, output:outputText(output), produced };
    }
    return { status:"accepted", output:outputText(output), produced };
  }

  async function finishWriterAttempt(input: {
    projectId:string; config:PrototypeConfig; task:TaskV2;
    runId:string; taskId:string; attemptId:string; pmThreadId:string; writerThreadId:string;
    dirtBefore:import("./src/cli-outcome").DirtSnapshot[];
  }): Promise<Record<string,unknown>> {
    try {
      const waited = await bb.sdk.threads.wait({ threadId:input.writerThreadId, status:"idle", timeoutMs:600_000 });
      if (!waited.matched) {
        transitionAttempt(db, input.attemptId, "timeout", { reason:"threads.wait did not observe idle" });
        await bb.sdk.threads.stop({ threadId:input.writerThreadId }).catch(() => undefined);
        return { status:"timeout", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      const waitedThread = valueAt(waited, "thread");
      if (stringAt(waitedThread, "status") === "error") {
        transitionAttempt(db, input.attemptId, "provider_error", { reason:"writer thread status error" });
        return { status:"provider_error", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
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
        pmThreadId:input.pmThreadId, writerThreadId:input.writerThreadId, output:checked.output,
      });
      transitionAttempt(db, input.attemptId, "accepted");
      return receipt;
    } catch (cause) {
      const thread = await bb.sdk.threads.get({ threadId:input.writerThreadId }).catch(() => null);
      if (stringAt(thread, "status") === "error") {
        transitionAttempt(db, input.attemptId, "provider_error", { reason:cause instanceof Error ? cause.message : String(cause) });
        return { status:"provider_error", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      throw cause;
    }
  }

  async function dispatchWriter(args:{threadId:string; projectId:string; task?:TaskV2}): Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    const config = loadPrototypeConfig(db, args.projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${args.projectId}`);
    if (listTaskKinds(db, runId).includes("cli")) {
      throw new Error("V1: BB writer cannot join a CLI run-controller run");
    }
    const taskId = args.task?.id ?? id("lptask");
    const prepared = args.task ?? buildTask(config, taskId);
    const valid = validateTaskV2(prepared);
    if (!valid.ok) throw new Error(`task-v2 invalid: ${valid.errors.join("; ")}`);
    createTask(db, { id:taskId, runId, kind:"bb", contract:valid.task });
    let last: Record<string, unknown> = {};
    while (countAttempts(db, runId, taskId) < MAIN_ATTEMPT_LIMIT) {
      const attemptId = id("lpattempt");
      createAttempt(db, { id:attemptId, runId, taskId });
      const spawned = await spawnWriterAttempt({
        projectId:args.projectId, runId, taskId, attemptId, config, task:valid.task, pmThreadId:args.threadId,
      });
      if (!spawned.ok) {
        last = { status:spawned.status, reason:spawned.reason, attemptId:spawned.attemptId };
      } else {
        last = await finishWriterAttempt({
          projectId:args.projectId, config, task:valid.task, runId, taskId, attemptId,
          pmThreadId:args.threadId, writerThreadId:spawned.threadId, dirtBefore:spawned.dirtBefore,
        });
      }
      if (last.status === "accepted") {
        refreshRun(runId);
        return last;
      }
      const failed = String(last.status) as AttemptState;
      if (!RETRY_ELIGIBLE.includes(failed)) {
        refreshRun(runId);
        return last;
      }
      const attempt = getAttempt(db, attemptId);
      if (attempt?.state === "spawn_unknown" || attempt?.state === "spawn_requested") {
        await reconcileAttemptThread(args.projectId, attempt).catch(() => undefined);
      } else if (attempt) {
        const key = { lanePilotRunId:attempt.run_id, lanePilotTaskId:attempt.task_id, attemptId:attempt.id };
        const scanned = await reconcile({
          list: async ({ limit, offset }) => (await bb.sdk.threads.list({
            projectId:args.projectId, originPluginId:"lane-pilot", includeHidden:true, limit, offset,
          })).map((thread) => ({ id:thread.id })),
          metadata: async (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }),
        }, key);
        if (scanned.kind === "blocked" || scanned.kind === "error") {
          if (scanned.kind === "blocked") transitionAttempt(db, attempt.id, "blocked", { reason:`reconcile_${scanned.reason}` });
          refreshRun(runId);
          return { ...last, status:"blocked", reason:scanned.kind === "blocked" ? scanned.reason : scanned.message };
        }
      }
    }
    const latest = getAttempt(db, String(last.attemptId ?? ""));
    if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) {
      transitionAttempt(db, latest.id, "blocked", { reason:"retry limit 2 exhausted" });
    }
    refreshRun(runId);
    return { ...last, status:"blocked", reason:"retry limit 2 exhausted" };
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
    activate_pm: ({ projectId, sourceThreadId }) => {
      if (!sourceThreadId) throw new Error("Open an ordinary thread before enabling Lane Pilot");
      return activate(projectId, sourceThreadId);
    },
    get_screen: ({ projectId }) => {
      const config = loadPrototypeConfig(db, projectId);
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
      const completed = values["import.completed"];
      const routing = values["import.routing_profile"];
      const night = values["import.night_shift"];
      const settings = loadProjectSettings(db, projectId);
      const invocationSettings: Record<string, unknown> = {};
      for (const spec of SETTING_CATALOG) {
        if (spec.key in settings) invocationSettings[spec.key] = settings[spec.key];
      }
      for (const [key, value] of Object.entries(settings)) {
        if (!isRuntimeSettingKey(key)) continue;
        if (!(key in invocationSettings)) invocationSettings[key] = value;
      }
      const unapplied = buildCliInvocation({
        binary: "run-controller",
        subcommand: "run",
        settings: invocationSettings,
      }).unapplied.map((item) => ({ key: item.key, reason: item.reason }));
      const listed = listRunsWithAttempts(db, projectId).map((run) => {
        const runReceipt = asJsonText(values[cliReceiptRunKey(run.id)]);
        return {
          ...run,
          cliReceiptJson: runReceipt,
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
        lastSnapshotPath: typeof values["install.lastSnapshotPath"] === "string" ? values["install.lastSnapshotPath"] as string : null,
        lastReceiptJson: asJsonText(values["install.lastReceipt"]),
        writerResultJson: asJsonText(values["writer.lastResult"]),
        writerResultPatch: asJsonText(values["writer.lastPatch"]),
        cliReceiptJson: latestReceipt,
      };
    },
    save_setting: ({ projectId, key, value, expectedVersion }) => {
      const result = casUpsertSetting(db, { projectId, key, value, expectedVersion });
      if (!result.ok) {
        if ("validation" in result) return result;
        return { ok: false, conflict: true, version: result.version, value: result.value };
      }
      return { ok: true, conflict: false, version: result.version, value };
    },
    save_settings: ({ projectId, changes }) => casUpsertSettings(db, { projectId, changes }),
    cancel_attempt: async ({ attemptId }) => {
      const attempt = getAttempt(db, attemptId);
      if (!attempt?.thread_id) return { ok: false, state: attempt?.state ?? "missing", reason: "attempt has no writer thread" };
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
      return host.call("detect", { requestedHostId: config.hostId, workspacePath: config.writerWorkspacePath }, { hostId: config.hostId });
    },
    stack_install: async ({ projectId, confirmExternalOps }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      const stored = loadProjectSettings(db, projectId);
      const installSettings: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(stored)) {
        if (key.startsWith("install.") && !key.startsWith("install.last")) installSettings[key] = value;
      }
      const receipt = await host.call("install", {
        requestedHostId: config.hostId,
        pmWorkspacePath: config.pmWorkspacePath,
        confirmExternalOps,
        installSettings,
      }, { hostId: config.hostId, timeoutMs: 600_000 });
      if (receipt.snapshotPath) saveProjectSetting(db, projectId, "install.lastSnapshotPath", receipt.snapshotPath);
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
    stack_connect: async ({ projectId, confirmExternalOps }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      const receipt = await host.call("connectOpencode", {
        requestedHostId: config.hostId,
        confirmExternalOps,
      }, { hostId: config.hostId, timeoutMs: 30_000 });
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
    stack_rollback: async ({ projectId, snapshotPath }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
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
    description:"Dispatch a task-v2 contract to the configured native BB writer and return its validated receipt.",
    instructions:"Use only from a Lane Pilot PM thread. Persists identity before spawn, retries at most twice, never falls back to Codex.",
    parameters:z.object({ confirm:z.literal(true), task:taskV2Schema.optional() }).strict(),
    execute: async (params, context) => JSON.stringify(
      await dispatchWriter({ threadId:context.threadId, projectId:context.projectId, task:params.task }),
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

  bb.agents.configure((context) => {
    const role = context.pluginMetadata.role;
    const runId = context.pluginMetadata.lanePilotRunId;
    if (context.origin.pluginId !== "lane-pilot" || role !== "pm" || typeof runId !== "string") return { tools:[], skills:[] };
    const config = loadPrototypeConfig(db, context.project.id);
    return {
      tools:["lane_pilot_dispatch_writer","lane_pilot_dispatch_cli"],
      skills:[],
      instructions:config
        ? `Lane Pilot PM ${runId}. Writer=${config.writerProviderId}/${config.writerModel}; writer workspace=${config.writerWorkspacePath}. The writer tool is available only in this PM thread.`
        : `Lane Pilot PM ${runId}, but project configuration is missing.`,
    };
  });

  const usage = [
    "bb lane-pilot configure <json>",
    "bb lane-pilot activate <project-id> <ordinary-source-thread-id>",
    "bb lane-pilot state <project-id>",
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
        if (command === "cancel" && args.length === 1) {
          const attempt = getAttempt(db, args[0]!);
          if (!attempt?.thread_id) throw new Error("attempt has no writer thread");
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
          const receipt = await persistWriterAcceptance({
            config, task:taskV2Schema.parse(savedTask.contract), runId:attempt.run_id,
            taskId:attempt.task_id, attempt:attempt.attempt_no, attemptId:attempt.id,
            pmThreadId:run.pm_thread_id, writerThreadId, output:outputText(output),
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
