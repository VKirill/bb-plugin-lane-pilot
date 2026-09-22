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
  setAttemptDirtBefore,
  setRunThread,
  transitionAttempt,
} from "../src/database";
import type { TaskV2 } from "../src/contracts";

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
  it("runs every verification command and fails on the second", async () => {
    const ran: string[] = [];
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
        if (command.includes("git status")) {
          return { hostId:"host-test", exitCode:0, stdout:"?? hello.txt\n", stderr:"" };
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
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, task },
      { threadId:pmThreadId, projectId },
    )));
    expect(ran.filter((command) => command === "true" || command === "false")).toEqual(["true", "false", "true", "false"]);
    expect(result.status).toBe("blocked");
    expect(String(result.reason)).toMatch(/false|retry limit|boom/);
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
          return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
        }
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-v", projectId);
    setRunThread(db, "run-v", pmThreadId);
    await plugin(bb);
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, task:{ ...task, id:"timeout1", verification:[{ command:"true", cwd:config.writerWorkspacePath }] } },
      { threadId:pmThreadId, projectId },
    )));
    expect(order[0]).toBe("state:timeout");
    expect(order[1]).toBe("stop");
    expect(result.status === "timeout" || result.status === "blocked").toBe(true);
    await harness.lifecycle.dispose();
  });

  it("finishes an idle orphan on resume instead of leaving it running", async () => {
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
          return { hostId:"host-test", exitCode:0, stdout:"?? hello.txt\n", stderr:"" };
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
    expect(getAttempt(db, "attempt-resume")?.state).toBe("empty_output");
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
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, task:{ ...task, id:"dirt-fail", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    expect(spawnCalled).toBe(0);
    expect(result.status).toBe("blocked");
    expect(String(result.reason)).toMatch(/git status failed|retry limit|cannot read writer-workspace/);
    expect(getAttempt(db, String(result.attemptId ?? ""))?.state === "blocked"
      || String(result.reason).includes("retry limit")).toBe(true);
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
