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
import {
  createAttempt,
  createRun,
  getAttempt,
  getRun,
  inspectState,
  loadPrototypeConfig,
  openDatabase,
  savePrototypeConfig,
  setRunThread,
  transitionAttempt,
} from "./src/database";
import { spawnWithSeam } from "./src/spawn-seam";

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
    "You are the native BB writer for a bounded Lane Pilot fixture task.",
    "Use the task-v2 contract below. Work only inside owns_paths.",
    "Create hello.txt with exactly `hello from native BB writer` and a trailing newline.",
    "Create tests/hello.test.txt with the same line and a trailing newline.",
    "Run the verification command, then answer with the changed paths and result.",
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

  async function activate(projectId: string, sourceThreadId: string): Promise<{threadId:string; runId:string}> {
    const sourceMetadata = await bb.sdk.threads.getPluginMetadata({ threadId:sourceThreadId });
    if (valueAt(sourceMetadata, "role") === "writer") {
      throw new Error("Lane Pilot writer threads cannot activate a PM");
    }
    const config = loadPrototypeConfig(db, projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${projectId}`);
    const runId = id("lprun");
    createRun(db, runId, projectId);
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
    return { threadId, runId };
  }

  async function dispatchWriter(args:{threadId:string; projectId:string}): Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    const config = loadPrototypeConfig(db, args.projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${args.projectId}`);
    const taskId = id("lptask");
    const attemptId = id("lpattempt");
    const task = buildTask(config, taskId);
    createAttempt(db, { id:attemptId, runId, taskId });
    transitionAttempt(db, attemptId, "spawn_requested");
    let writerThreadId: string;
    try {
      const spawned = await spawnWithSeam(() => bb.sdk.threads.spawn({
        projectId: args.projectId,
        providerId: config.writerProviderId,
        model: config.writerModel,
        prompt: writerPrompt(task),
        environment: {
          type:"host",
          hostId:config.hostId,
          workspace:{ type:"unmanaged", path:config.writerWorkspacePath },
        },
        visibility:"hidden",
        pluginMetadata:{
          role:"writer",
          lanePilotRunId:runId,
          lanePilotTaskId:taskId,
          attemptId,
          parentPmThreadId:args.threadId,
        },
        executionInputSources:{ providerId:"explicit", model:"explicit" },
      }));
      writerThreadId = stringAt(spawned, "id") ?? "";
      if (!writerThreadId) throw new Error("threads.spawn returned no writer thread id");
      transitionAttempt(db, attemptId, "running", { threadId:writerThreadId });
    } catch (cause) {
      transitionAttempt(db, attemptId, "spawn_unknown", { reason:cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    }
    try {
      const waited = await bb.sdk.threads.wait({ threadId:writerThreadId, status:"idle", timeoutMs:600_000 });
      const waitedThread = valueAt(waited, "thread");
      if (stringAt(waitedThread, "status") === "error") {
        transitionAttempt(db, attemptId, "provider_error", { reason:"writer thread status error" });
        throw new Error("writer provider error");
      }
      const output = await bb.sdk.threads.output({ threadId:writerThreadId });
      const helloPath = `${config.writerWorkspacePath}/hello.txt`;
      const testPath = `${config.writerWorkspacePath}/tests/hello.test.txt`;
      const [hello, test] = await Promise.all([
        bb.sdk.files.read({ hostId:config.hostId, rootPath:config.writerWorkspacePath, path:helloPath }),
        bb.sdk.files.read({ hostId:config.hostId, rootPath:config.writerWorkspacePath, path:testPath }),
      ]);
      const helloContent = stringAt(hello, "content") ?? "";
      const testContent = stringAt(test, "content") ?? "";
      if (helloContent !== "hello from native BB writer\n" || testContent !== "hello from native BB writer\n") {
        transitionAttempt(db, attemptId, "validation_failed", { reason:"fixture output content mismatch" });
        throw new Error("writer output failed owns_paths/content validation");
      }
      const receipt = {
        schemaVersion:1,
        status:"accepted",
        lanePilotRunId:runId,
        lanePilotTaskId:taskId,
        attemptId,
        pmThreadId:args.threadId,
        writerThreadId,
        ownsPaths:["hello.txt", "tests/hello.test.txt"],
        output:outputText(output),
      };
      await bb.sdk.files.write({
        hostId:config.hostId,
        rootPath:config.writerWorkspacePath,
        path:`${config.writerWorkspacePath}/acceptance.json`,
        content:JSON.stringify(receipt, null, 2) + "\n",
        contentEncoding:"utf8",
        createParents:true,
        expectedSha256:null,
      });
      transitionAttempt(db, attemptId, "accepted");
      return receipt;
    } catch (cause) {
      const thread = await bb.sdk.threads.get({ threadId:writerThreadId }).catch(() => null);
      if (stringAt(thread, "status") === "error") {
        transitionAttempt(db, attemptId, "provider_error", { reason:cause instanceof Error ? cause.message : String(cause) });
      }
      throw cause;
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

  bb.rpc.register(rpcContract, {
    activate_pm: ({ projectId, sourceThreadId }) => {
      if (!sourceThreadId) throw new Error("Open an ordinary thread before enabling Lane Pilot");
      return activate(projectId, sourceThreadId);
    },
  });

  bb.agents.registerTool({
    name:"lane_pilot_dispatch_writer",
    description:"Dispatch the fixed stage-0 task to the configured native BB writer and return its validated receipt.",
    instructions:"Use only from a Lane Pilot PM thread after the guard probes. The tool persists identity before spawn and returns acceptance.json data.",
    parameters:z.object({ confirm:z.literal(true) }).strict(),
    execute: async (_params, context) => JSON.stringify(
      await dispatchWriter({ threadId:context.threadId, projectId:context.projectId }),
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
      tools:["lane_pilot_dispatch_writer"],
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
    "bb lane-pilot host-detect <host-id> <workspace-path>",
    "bb lane-pilot host-snapshot <host-id> <absolute-path>...",
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
      { name:"host-detect", summary:"Call the read-only host worker detect method", usage:"bb lane-pilot host-detect <host-id> <workspace-path>" },
      { name:"host-snapshot", summary:"Call read-only snapshotDryRun", usage:"bb lane-pilot host-snapshot <host-id> <absolute-path>..." },
    ],
    async run(argv) {
      try {
        const [command, ...args] = argv;
        if (command === "configure" && args.length === 1) {
          const config = prototypeConfigSchema.parse(JSON.parse(args[0]!));
          savePrototypeConfig(db, config);
          return { exitCode:0, stdout:JSON.stringify({ ok:true, projectId:config.projectId }) };
        }
        if (command === "activate" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await activate(args[0]!, args[1]!)) };
        }
        if (command === "state" && args.length === 1) {
          return { exitCode:0, stdout:JSON.stringify(inspectState(db, args[0]!), null, 2) };
        }
        if (command === "cancel" && args.length === 1) {
          const attempt = getAttempt(db, args[0]!);
          if (!attempt?.thread_id) throw new Error("attempt has no writer thread");
          await bb.sdk.threads.stop({ threadId:attempt.thread_id });
          const observed = await bb.sdk.threads.wait({ threadId:attempt.thread_id, status:"idle", timeoutMs:30_000 });
          if (!observed.matched) throw new Error("writer stop was not independently observed");
          transitionAttempt(db, attempt.id, "canceled", { threadId:attempt.thread_id });
          return { exitCode:0, stdout:JSON.stringify({ ok:true, attemptId:attempt.id, threadId:attempt.thread_id, state:"canceled" }) };
        }
        if (command === "recover" && args.length === 1) {
          const attempt = getAttempt(db, args[0]!);
          if (!attempt?.thread_id) throw new Error("attempt has no writer thread");
          const run = getRun(db, attempt.run_id);
          if (!run?.pm_thread_id) throw new Error("attempt run has no PM thread");
          const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:attempt.thread_id });
          if (valueAt(metadata, "lanePilotRunId") !== attempt.run_id
            || valueAt(metadata, "lanePilotTaskId") !== attempt.task_id
            || valueAt(metadata, "attemptId") !== attempt.id) {
            transitionAttempt(db, attempt.id, "blocked", { threadId:attempt.thread_id, reason:"idempotency triple mismatch" });
            throw new Error("writer metadata does not match the persisted idempotency triple");
          }
          const thread = await bb.sdk.threads.get({ threadId:attempt.thread_id });
          if (stringAt(thread, "status") !== "idle") throw new Error(`writer is not idle: ${stringAt(thread, "status") ?? "unknown"}`);
          const config = loadPrototypeConfig(db, run.project_id);
          if (!config) throw new Error("prototype configuration is missing");
          const [hello, test, output] = await Promise.all([
            bb.sdk.files.read({ hostId:config.hostId, rootPath:config.writerWorkspacePath, path:`${config.writerWorkspacePath}/hello.txt` }),
            bb.sdk.files.read({ hostId:config.hostId, rootPath:config.writerWorkspacePath, path:`${config.writerWorkspacePath}/tests/hello.test.txt` }),
            bb.sdk.threads.output({ threadId:attempt.thread_id }),
          ]);
          if (stringAt(hello, "content") !== "hello from native BB writer\n"
            || stringAt(test, "content") !== "hello from native BB writer\n") {
            transitionAttempt(db, attempt.id, "validation_failed", { threadId:attempt.thread_id, reason:"fixture output content mismatch" });
            throw new Error("reconciled writer output failed validation");
          }
          const receipt = {
            schemaVersion:1, status:"accepted", reconciled:true,
            lanePilotRunId:attempt.run_id, lanePilotTaskId:attempt.task_id, attemptId:attempt.id,
            pmThreadId:run.pm_thread_id, writerThreadId:attempt.thread_id,
            ownsPaths:["hello.txt", "tests/hello.test.txt"], output:outputText(output),
          };
          await bb.sdk.files.write({
            hostId:config.hostId, rootPath:config.writerWorkspacePath,
            path:`${config.writerWorkspacePath}/acceptance.json`,
            content:JSON.stringify(receipt, null, 2) + "\n", contentEncoding:"utf8",
            createParents:true, expectedSha256:null,
          });
          transitionAttempt(db, attempt.id, "accepted", { threadId:attempt.thread_id });
          return { exitCode:0, stdout:JSON.stringify(receipt, null, 2) };
        }
        if (command === "start-cancel-probe" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await startCancelProbe(args[0]!, args[1]!), null, 2) };
        }
        if (command === "host-detect" && args.length === 2) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("detect", { requestedHostId:args[0]!, workspacePath:args[1]! }, { hostId:args[0]! }), null, 2) };
        }
        if (command === "host-snapshot" && args.length >= 2) {
          return { exitCode:0, stdout:JSON.stringify(await host.call("snapshotDryRun", { requestedHostId:args[0]!, paths:args.slice(1) }, { hostId:args[0]! }), null, 2) };
        }
        return { exitCode:1, stderr:usage };
      } catch (cause) {
        return { exitCode:1, stderr:cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });

  bb.log.info("Lane Pilot stage-0 loaded");
}
