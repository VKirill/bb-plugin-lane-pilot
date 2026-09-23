import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import {
  createAttempt,
  createRun,
  createTask,
  getAttempt,
  getRun,
  openDatabase,
  savePrototypeConfig,
  saveProjectSetting,
  setAttemptDirtBefore,
  setRunThread,
  transitionAttempt,
} from "../src/database";
import type { TaskV2 } from "../src/contracts";
import { validateAcceptanceV2 } from "../src/acceptance-v2";

const projectId = "project-test";
const pmThreadId = "pm-thread";
const config = {
  projectId,
  hostId:"host-test",
  pmWorkspacePath:"/tmp/pm",
  writerWorkspacePath:"/tmp/writer",
  pmProviderId:"claude-code",
  pmModel:"claude-test",
  writerProviderId:"codex",
  writerModel:"codex-test",
};

const task: TaskV2 = {
  schema_version:2,
  id:"two-verify",
  title:"Two verification commands",
  risk:"low",
  lane:"writer",
  project_cwd:config.writerWorkspacePath,
  read_first:["README.md"],
  interfaces:["i"],
  invariants:["inv"],
  out_of_scope:["out"],
  expected_outputs:["hello.txt"],
  owns_paths:["hello.txt"],
  never_touch:[".git/**"],
  depends_on:[],
  objective:"create hello then fail second verify",
  acceptance:["never"],
  verify:"tests",
  verification:[
    { command:"true", cwd:config.writerWorkspacePath, timeout_sec:5 },
    { command:"false", cwd:config.writerWorkspacePath, timeout_sec:5 },
  ],
};

describe("BB writer validation on the server path", () => {
  it("returns dispatch immediately and exposes the persisted receipt through bounded wait", async () => {
    let releaseWait!: (value:{matched:boolean; thread:{status:string}}) => void;
    let snapshots = 0;
    const delayed = new Promise<{matched:boolean; thread:{status:string}}>((resolve) => { releaseWait = resolve; });
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{ threads:{
        getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
          ? { role:"pm", lanePilotRunId:"run-delayed" }
          : { role:"writer" },
        spawn: async () => ({ id:"writer-delayed" }),
        wait: async () => delayed,
        get: async () => ({ id:"writer-delayed", status:"idle" }),
        output: async () => ({ text:"writer output" }),
        list: async () => [] as never,
      }, files:{
        read: async ({ path }) => path.endsWith("hello.txt") ? { content:"hello\n" } : { content:null },
        write: async () => ({ ok:true }),
      } },
      experimental_callHostRpc: (call) => {
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        const command = String((call.input as { command?:string }).command ?? "");
        return { hostId:"host-test", exitCode:0, stdout:command.includes("porcelain")
          ? JSON.stringify(++snapshots === 1 ? [] : [{ path:"hello.txt", sha256:"written" }]) : "", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-delayed", projectId);
    setRunThread(db, "run-delayed", pmThreadId);
    await plugin(bb);
    const startedAt = Date.now();
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, task:{ ...task, id:"delayed-task", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(dispatched).toMatchObject({ runId:"run-delayed", state:"queued", attemptId:expect.any(String), writerThreadId:null });
    const stillRunning = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:"run-delayed", timeoutSec:1 }, { threadId:pmThreadId, projectId },
    )));
    releaseWait({ matched:true, thread:{ status:"idle" } });
    expect(stillRunning).toMatchObject({ state:"running", attemptId:dispatched.attemptId, writerThreadId:"writer-delayed" });
    const completed = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:"run-delayed", timeoutSec:2 }, { threadId:pmThreadId, projectId },
    )));
    expect(completed).toMatchObject({ state:"accepted", receipt:{ lanePilotRunId:"run-delayed", attemptId:dispatched.attemptId } });
    await harness.lifecycle.dispose();
  });

  it("blocks CLI dispatch with a corrupt provider setting before calling the host", async () => {
    let hostCalls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: { getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "run-invalid-provider" }) } },
      experimental_callHostRpc: () => {
        hostCalls += 1;
        throw new Error("invalid provider reached host");
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "writer.provider", "not-a-provider");
    createRun(db, "run-invalid-provider", projectId, "cli");
    setRunThread(db, "run-invalid-provider", pmThreadId);
    await plugin(bb);
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_cli",
      { confirm: true, binary: "run-controller", subcommand: "run" },
      { threadId: pmThreadId, projectId },
    )));
    expect(result.status).toBe("blocked");
    expect(result.applied).not.toContain("writer.provider");
    expect(result.argv).not.toContain("--provider");
    expect(result.unapplied).toContainEqual(expect.objectContaining({
      key: "writer.provider",
      reason: expect.stringMatching(/invalid value; allowed:/),
    }));
    expect(hostCalls).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("blocks an incompatible stored provider-effort pair before calling the host", async () => {
    let hostCalls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: { getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "run-invalid-pair" }) } },
      experimental_callHostRpc: () => { hostCalls += 1; throw new Error("invalid pair reached host"); },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "writer.provider", "qwen");
    saveProjectSetting(db, projectId, "writer.reasoning_effort", "max");
    createRun(db, "run-invalid-pair", projectId, "cli");
    setRunThread(db, "run-invalid-pair", pmThreadId);
    await plugin(bb);
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_cli",
      { confirm: true, binary: "run-controller", subcommand: "run" },
      { threadId: pmThreadId, projectId },
    )));
    expect(result.status).toBe("blocked");
    expect(result.argv).not.toContain("--reasoning-effort");
    expect(result.applied).not.toContain("writer.reasoning_effort");
    expect(result.unapplied).toContainEqual(expect.objectContaining({
      key: "writer.reasoning_effort",
      reason: expect.stringContaining("writer.provider=qwen"),
    }));
    expect(hostCalls).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("writes upstream acceptance-v2 under the run/task artifact directory", async () => {
    const written = new Map<string, string>();
    let snapshots = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-accepted" }
            : { role:"writer" },
          spawn: async () => ({ id:"writer-accepted" }),
          wait: async () => ({ matched:true, thread:{ status:"idle" } }),
          get: async () => ({ id:"writer-accepted", status:"idle" }),
          output: async () => ({ text:"writer output" }),
          list: async () => [] as never,
        },
        files:{
          read: async ({ path }) => path.endsWith("hello.txt") ? { content:"hello\n" } : { content:null },
          write: async ({ path, content }) => {
            written.set(String(path), String(content));
            return { ok:true };
          },
        },
      },
      experimental_callHostRpc: (call) => {
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        const command = String((call.input as { command?:string }).command ?? "");
        if (command.includes("porcelain")) {
          snapshots += 1;
          return {
            hostId:"host-test", exitCode:0,
            stdout:JSON.stringify(snapshots === 1 ? [] : [{ path:"hello.txt", sha256:"new-content" }]),
            stderr:"",
          };
        }
        return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-accepted", projectId);
    setRunThread(db, "run-accepted", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, task:{ ...task, id:"accepted-task", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    expect(dispatched).toMatchObject({ runId:"run-accepted", state:"queued", attemptId:expect.any(String), writerThreadId:null });
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:"run-accepted", timeoutSec:2 }, { threadId:pmThreadId, projectId },
    )));
    expect(result.state).toBe("accepted");

    const acceptancePath = "/tmp/writer/.agents/runs/run-accepted/artifacts/accepted-task/acceptance.json";
    const acceptance = JSON.parse(written.get(acceptancePath) ?? "null") as unknown;
    expect(validateAcceptanceV2(acceptance)).toEqual({ ok:true });
    expect(written.has("/tmp/writer/.agents/runs/run-accepted/artifacts/accepted-task/lane-pilot-receipt.json")).toBe(true);
    expect(written.has("/tmp/writer/acceptance.json")).toBe(false);
    await harness.lifecycle.dispose();
  });

  it("runs every verification command and fails on the second", async () => {
    const ran: string[] = [];
    let snapshots = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-v" }
            : { role:"writer" },
          spawn: async () => ({ id:"writer-real" }),
          wait: async () => ({ matched:true, thread:{ status:"idle" } }),
          get: async () => ({ id:"writer-real", status:"idle" }),
          output: async () => ({ text:"ok" }),
          list: async () => [] as never,
        },
        files:{
          read: async ({ path }) => path.endsWith("hello.txt") ? { content:"hello\n" } : { content:null },
          write: async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc: (call) => {
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        const command = String((call.input as { command?:string }).command ?? "");
        ran.push(command);
        if (command.includes("porcelain")) {
          return { hostId:"host-test", exitCode:0, stdout:JSON.stringify(
            ++snapshots === 1 || snapshots === 3 ? [] : [{ path:"hello.txt", sha256:snapshots === 2 ? "attempt-1" : "attempt-2" }],
          ), stderr:"" };
        }
        if (command === "true") return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
        if (command === "false") return { hostId:"host-test", exitCode:1, stdout:"", stderr:"boom" };
        return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-v", projectId);
    setRunThread(db, "run-v", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, task },
      { threadId:pmThreadId, projectId },
    )));
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:dispatched.runId, timeoutSec:3 }, { threadId:pmThreadId, projectId },
    )));
    expect(ran.filter((command) => command === "true" || command === "false")).toEqual(["true", "false", "true", "false"]);
    expect(result.state).toBe("blocked");
    await harness.lifecycle.dispose();
  });

  it("marks timeout and calls threads.stop when wait does not match idle", async () => {
    const order: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-v" }
            : { role:"writer" },
          spawn: async () => ({ id:"writer-timeout" }),
          wait: async () => ({ matched:false, thread:{ status:"active" } }),
          get: async () => ({ id:"writer-timeout", status:"active" }),
          stop: async () => {
            const row = db.prepare("SELECT state FROM lane_pilot_attempt ORDER BY created_at DESC LIMIT 1").get() as {state:string};
            order.push(`state:${row.state}`);
            order.push("stop");
            return { ok:true };
          },
          output: async () => ({ text:"ok" }),
          list: async () => [] as never,
        },
        files:{
          read: async () => ({ content:null }),
          write: async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc: (call) => {
        if (call.method === "runCommand") {
          return { hostId:"host-test", exitCode:0, stdout:"[]", stderr:"" };
        }
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-v", projectId);
    setRunThread(db, "run-v", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, task:{ ...task, id:"timeout1", verification:[{ command:"true", cwd:config.writerWorkspacePath }] } },
      { threadId:pmThreadId, projectId },
    )));
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:dispatched.runId, timeoutSec:3 }, { threadId:pmThreadId, projectId },
    )));
    expect(order[0]).toBe("state:timeout");
    expect(order[1]).toBe("stop");
    expect(result.state === "timeout" || result.state === "blocked").toBe(true);
    await harness.lifecycle.dispose();
  });

  it("fails closed when a resumed attempt has a pre-dirty path without a content hash", async () => {
    const resumeTask: TaskV2 = { ...task, id:"resume-task", verify:"none", verification:[] };
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }) => threadId === "writer-orphan"
            ? { role:"writer", lanePilotRunId:"run-resume", lanePilotTaskId:"resume-task", attemptId:"attempt-resume" }
            : { role:"pm", lanePilotRunId:"run-resume" },
          get: async () => ({ id:"writer-orphan", status:"idle" }),
          wait: async () => ({ matched:true, thread:{ status:"idle" } }),
          output: async () => ({ text:"orphan idle" }),
          list: async () => [{ id:"writer-orphan" }] as never,
        },
        files:{
          read: async ({ path }) => path.endsWith("hello.txt") ? { content:"stale\n" } : { content:null },
          write: async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc: (call) => {
        if (call.method === "runCommand") {
          return { hostId:"host-test", exitCode:0, stdout:JSON.stringify([{ path:"hello.txt", sha256:"unchanged" }]), stderr:"" };
        }
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-resume", projectId);
    setRunThread(db, "run-resume", pmThreadId);
    createTask(db, { id:"resume-task", runId:"run-resume", kind:"bb", contract:resumeTask });
    createAttempt(db, { id:"attempt-resume", runId:"run-resume", taskId:"resume-task" });
    transitionAttempt(db, "attempt-resume", "running", { threadId:"writer-orphan" });
    setAttemptDirtBefore(db, "attempt-resume", ["hello.txt"]);
    await plugin(bb);
    expect(getAttempt(db, "attempt-resume")?.state).toBe("validation_failed");
    await harness.lifecycle.dispose();
  });

  it("classifies a failed lane-ctl status as blocked even when the process exits 0", async () => {
    let receiptStatus = "";
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async () => ({ role:"pm", lanePilotRunId:"run-cli" }),
        },
        files:{
          write: async ({ content }) => {
            const parsed = JSON.parse(String(content)) as { status?:string };
            receiptStatus = parsed.status ?? "";
            return { ok:true };
          },
        },
      },
      experimental_callHostRpc: (call) => {
        if (call.method !== "runCli") throw new Error(`unexpected ${call.method}`);
        return {
          hostId:"host-test",
          binaryPath:"/usr/bin/lane-ctl",
          argv:["status", "--run-dir", "/tmp/writer/.agents/runs/lane-pilot-run-cli", "--task-id", "001"],
          env:{},
          cwd:"/tmp/writer",
          exitCode:0,
          stdout: JSON.stringify({ status:"failed", accepted:false, exit_code:71 }),
          stderr:"",
        };
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-cli", projectId, "cli");
    setRunThread(db, "run-cli", pmThreadId);
    await plugin(bb);
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_cli",
      { confirm:true, binary:"lane-ctl", subcommand:"status", taskId:"001" },
      { threadId:pmThreadId, projectId },
    )));
    expect(result.status).toBe("blocked");
    expect(result.taskAccepted).toBe(false);
    expect(result.upstreamStatus).toBe("failed");
    expect(receiptStatus).toBe("blocked");
    expect(getRun(db, "run-cli")?.state).toBe("blocked");
    await harness.lifecycle.dispose();
  });

  it("does not spawn when the dirt snapshot fails", async () => {
    let spawnCalled = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-dirt" }
            : { role:"writer" },
          spawn: async () => {
            spawnCalled += 1;
            return { id:"writer-should-not-exist" };
          },
          wait: async () => ({ matched:true, thread:{ status:"idle" } }),
          get: async () => ({ id:"writer-should-not-exist", status:"idle" }),
          output: async () => ({ text:"ok" }),
          list: async () => [] as never,
        },
        files:{
          read: async () => ({ content:"hello\n" }),
          write: async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc: (call) => {
        if (call.method === "runCommand") {
          return { hostId:"host-test", exitCode:1, stdout:"", stderr:"git status failed" };
        }
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-dirt", projectId);
    setRunThread(db, "run-dirt", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, task:{ ...task, id:"dirt-fail", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:dispatched.runId, timeoutSec:3 }, { threadId:pmThreadId, projectId },
    )));
    expect(spawnCalled).toBe(0);
    expect(result.state).toBe("blocked");
    expect(getAttempt(db, dispatched.attemptId)?.state).toBe("spawn_rejected");
    await harness.lifecycle.dispose();
  });

  it("writes cancel_requested before stop and canceled only after get/listRunning", async () => {
    const order: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          stop: async () => {
            order.push("stop");
            return { ok:true };
          },
          get: async () => {
            order.push("get");
            return { id:"writer-cancel", status:"idle" };
          },
          listRunning: async () => {
            order.push("listRunning");
            return [];
          },
        },
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-cancel", projectId);
    createAttempt(db, { id:"attempt-cancel", runId:"run-cancel", taskId:"t" });
    transitionAttempt(db, "attempt-cancel", "running", { threadId:"writer-cancel" });
    await plugin(bb);
    const result = await harness.behavior.runCli(["cancel", "attempt-cancel"]);
    expect(result.exitCode).toBe(0);
    expect(getAttempt(db, "attempt-cancel")?.state).toBe("canceled");
    expect(order[0]).toBe("stop");
    expect(order).toContain("get");
    expect(order).toContain("listRunning");
    await harness.lifecycle.dispose();
  });
});

describe("CLI receipts per run", () => {
  it("keeps both dispatch-cli receipts on get_screen", async () => {
    const metadata: Record<string, { role: string; lanePilotRunId: string }> = {
      "pm-a": { role: "pm", lanePilotRunId: "run-a" },
      "pm-b": { role: "pm", lanePilotRunId: "run-b" },
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }) => metadata[threadId] ?? {},
        },
        files: { write: async () => ({ ok: true }) },
      },
      experimental_callHostRpc: (call) => {
        if (call.method !== "runCli") throw new Error(`unexpected ${call.method}`);
        return {
          hostId: "host-test",
          binaryPath: "/usr/bin/run-controller",
          argv: ["run"],
          env: {},
          cwd: "/tmp/writer",
          exitCode: 0,
          stdout: JSON.stringify({ status: "accepted" }),
          stderr: "",
        };
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-a", projectId, "cli");
    setRunThread(db, "run-a", "pm-a");
    createRun(db, "run-b", projectId, "cli");
    setRunThread(db, "run-b", "pm-b");
    await plugin(bb);
    await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_cli",
      { confirm: true, binary: "run-controller", subcommand: "run" },
      { threadId: "pm-a", projectId },
    );
    await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_cli",
      { confirm: true, binary: "run-controller", subcommand: "run" },
      { threadId: "pm-b", projectId },
    );
    const screen = await harness.behavior.callRpc("get_screen", { projectId }) as {
      runs: Array<{
        id: string;
        cliReceiptJson: string | null;
        attempts: Array<{ cliReceiptJson: string | null }>;
      }>;
    };
    const first = screen.runs.find((run) => run.id === "run-a");
    const second = screen.runs.find((run) => run.id === "run-b");
    expect(first?.cliReceiptJson).toContain("run-a");
    expect(second?.cliReceiptJson).toContain("run-b");
    expect(first?.attempts[0]?.cliReceiptJson).toContain("run-a");
    expect(second?.attempts[0]?.cliReceiptJson).toContain("run-b");
    await harness.lifecycle.dispose();
  });
});
