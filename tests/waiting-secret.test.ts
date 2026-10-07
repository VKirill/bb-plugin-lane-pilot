import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createFakeWorktreeHost } from "./own-worktree-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import type { TaskV2 } from "../src/contracts";
import {
  countChargedAttempts, createAttempt, createRun, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread, transitionAttempt,
} from "../src/database";
import { failureClass, isWaitingSecret, nextStep } from "../src/failure-class";
import { forgetSecrets } from "../src/redact";
import { createSecrets } from "../src/server/secrets";
import { createStability } from "../src/server/stability";

// Test values only: none of them is a real credential.
const KEY = "test-wait-key-Qw83LmZx1p";

describe("a task that waits for a secret", () => {
  it("is of class contract, spends no attempt and tells the PM what to do", () => {
    expect(failureClass("blocked", "waiting_secret:STRIPE_TEST_KEY")).toBe("contract");
    expect(isWaitingSecret("waiting_secret:A,B")).toBe(true);
    expect(isWaitingSecret("verification failed")).toBe(false);
    expect(nextStep("blocked", "waiting_secret:STRIPE_TEST_KEY")).toMatch(/env_request[\s\S]*no attempt is spent/);
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T','run','bb','{}',1)").run();
    createAttempt(db, { id:"a1", runId:"run", taskId:"T" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId:"thr_a1" });
    transitionAttempt(db, "a1", "validation_failed", { reason:"waiting_secret:STRIPE_TEST_KEY" });
    expect(countChargedAttempts(db, "run", "T")).toBe(0);
  });
});

describe("parked for a secret", () => {
  function setup(catalog:() => Array<{ name:string; kind:"secret" }>) {
    const sent:string[] = [];
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{
      threads:{ send:async (args:{ input:Array<{ text:string }> }) => { sent.push(args.input[0]!.text); return {}; } },
      plugins:{ callRpc:async () => ({ variables:catalog() }) },
    } as never });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm', writer_workspace_path='/repo' WHERE id='run'").run();
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T','run','bb','{}',1)").run();
    const resumed:string[] = [];
    const services = { activeWriterTasks:new Set<string>(), enqueueResumedWriter:async (_p:string, attempt:{ task_id:string }) => { resumed.push(attempt.task_id); return true; } };
    const { stability } = createStability({ bb, db, log:() => undefined, secrets:createSecrets({ bb }) } as never, services as never);
    return { db, stability, resumed, sent };
  }

  it("parks, restarts only when the name is saved and allowed, and gives up after a day", async () => {
    let saved:Array<{ name:string; kind:"secret" }> = [];
    const { db, stability, resumed } = setup(() => saved);
    // The owner restricted the list, so a saved name still needs to be on it.
    saveProjectSetting(db, "proj", "secrets.allow", "OTHER_KEY");
    const fail = { projectId:"proj", runId:"run", taskId:"T", pmThreadId:"pm", state:"validation_failed", reason:"waiting_secret:LATE_KEY" };
    expect(await stability.onTaskFailed(fail, 1000)).toBe(true);
    expect((await stability.loadParked())[0]).toMatchObject({ klass:"contract", reason:"waiting_secret:LATE_KEY" });
    expect(await stability.sweep(2000)).toEqual([]);
    saved = [{ name:"LATE_KEY", kind:"secret" }];
    expect(await stability.sweep(3000)).toEqual([]); // saved, but the owner has not allowed it
    saveProjectSetting(db, "proj", "secrets.allow", "OTHER_KEY, LATE_KEY");
    expect(await stability.sweep(4000)).toEqual(["T"]);
    expect(resumed).toEqual(["T"]);
    expect(await stability.loadParked()).toEqual([]);

    saved = [];
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('U','run','bb','{}',1)").run();
    await stability.onTaskFailed({ ...fail, taskId:"U" }, 1000);
    expect(await stability.sweep(1000 + 25 * 3600_000)).toEqual([]);
    expect(await stability.loadParked()).toEqual([]);
  });
});

const projectId = "project-test";
const pmThreadId = "pm-thread";
// A git project gives every writer attempt its own worktree.
const worktreeHost = (options:NonNullable<Parameters<typeof createFakePluginHost>[0]>) => createFakeWorktreeHost(options, "host-test");
const config = { projectId, hostId:"host-test", pmWorkspacePath:"/tmp/pm", writerWorkspacePath:"/tmp/writer", pmProviderId:"claude-code", pmModel:"claude-test", writerProviderId:"codex", writerModel:"codex-test" };
const task:TaskV2 = {
  schema_version:2, id:"needs-secret", title:"Needs a secret", risk:"low", lane:"writer", project_cwd:config.writerWorkspacePath, read_first:["README.md"],
  interfaces:["i"], invariants:["inv"], out_of_scope:["out"], expected_outputs:["hello.txt"], owns_paths:["hello.txt"], never_touch:[".git/**"], depends_on:[],
  objective:"create hello", acceptance:["done"], verify:"tests",
  verification:[{ command:"node e2e.js", cwd:config.writerWorkspacePath, timeout_sec:5, secrets:["WAIT_KEY"] }],
};

describe("dispatch of a task whose check needs a secret", () => {
  beforeEach(() => { process.env.LANE_PILOT_SECRET_POLL_MS = "50"; });
  afterEach(() => { delete process.env.LANE_PILOT_SECRET_POLL_MS; forgetSecrets(); });

  it("waits with waiting_secret, tells the PM, then runs once the owner saved it, and the secret never lands in a receipt or a message", async () => {
    let catalog:Array<{ name:string; kind:"secret"; value?:string }> = [];
    let spawned = 0;
    let snapshots = 0;
    const sandboxCalls:Array<Record<string, unknown>> = [];
    const messages:string[] = [];
    const written = new Map<string, string>();
    const { bb, harness } = worktreeHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }:{ threadId:string }) => threadId === pmThreadId ? { role:"pm", lanePilotRunId:"run-s" } : { role:"writer" },
          spawn: async () => { spawned++; return { id:"writer-s" }; },
          wait: async () => ({ matched:true, thread:{ status:"idle" } }),
          get: async ({ threadId }:{ threadId:string }) => threadId === pmThreadId
            ? { id:pmThreadId, status:"idle", projectId, sourceThreadId:pmThreadId, lifecycleOwnerThreadId:pmThreadId } : { id:"writer-s", status:"idle" },
          output: async () => ({ text:"done" }),
          list: async () => [] as never,
          send: async (args:{ input:Array<{ text:string }> }) => { messages.push(args.input[0]!.text); return {}; },
        },
        providers:{ list: async () => [{ id:"codex", available:true, capabilities:{ supportsServiceTier:true }, serviceTiers:[{ id:"default", label:"Default" }] }] as never,
          models: async () => ({ models:[{ id:"codex-test", model:"codex-test", supportedReasoningEfforts:["medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })) }] as never }) },
        files:{
          read: async ({ path }:{ path:string }) => path.endsWith("README.md") ? { content:"fixture\n" } : path.endsWith("hello.txt") ? { content:"hello\n" } : { content:null },
          write: async ({ path, content }:{ path:string; content:string }) => { written.set(String(path), String(content)); return { ok:true }; },
        },
        plugins:{ callRpc: async ({ method, input }:{ method:string; input:{ name?:string } }) => {
          if (method === "env_list") return { variables:catalog.map(({ name, kind }) => ({ name, kind })) };
          const row = catalog.find((candidate) => candidate.name === input.name)!;
          return { name:row.name, kind:row.kind, value:row.value ?? null, access:null };
        } },
      } as never,
      experimental_callHostRpc: (call) => {
        if (call.method === "gitOwnershipBase") return { hostId:"host-test", status:"not-git", branch:null, headSha:null, baseRef:null, baseSha:null, compareCommitted:false, reason:"fixture" };
        if (call.method === "runSandboxedCommand") {
          sandboxCalls.push(call.input as Record<string, unknown>);
          return { hostId:"host-test", backend:"macos-seatbelt", workspacePath:config.writerWorkspacePath, cwd:config.writerWorkspacePath, exitCode:0, policySha256:"d".repeat(64), stdout:`using ${KEY}\n`, stderr:"" };
        }
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        const command = String((call.input as { command?:string }).command ?? "");
        if (command.includes("porcelain")) { snapshots += 1; return { hostId:"host-test", exitCode:0, stdout:JSON.stringify(snapshots % 2 === 1 ? [] : [{ path:"hello.txt", sha256:"new-content" }]), stderr:"" }; }
        return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "plan_critique.enabled", false);
    saveProjectSetting(db, projectId, "memory.enabled", false);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    saveProjectSetting(db, projectId, "secrets.allow", "WAIT_KEY");
    createRun(db, "run-s", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-s", pmThreadId);
    await plugin(bb);

    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
      { confirm:true, plan:"Plan", task }, { threadId:pmThreadId, projectId })));
    // Not in the catalog yet: a warning for the PM, not a refusal.
    expect(dispatched.state).toBe("queued");
    expect(JSON.stringify(dispatched.warnings)).toContain("env_request");
    await new Promise((wake) => setTimeout(wake, 400));
    expect(spawned).toBe(0);
    expect(messages.join("\n")).toContain("env_request");
    expect(messages.join("\n")).toContain("WAIT_KEY");
    const waiting = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_wait_writer", { runId:"run-s", timeoutSec:1 }, { threadId:pmThreadId, projectId })));
    expect(JSON.stringify(waiting)).toContain("waiting_secret:WAIT_KEY");
    expect(countChargedAttempts(db, "run-s", "needs-secret")).toBeLessThanOrEqual(1);

    catalog = [{ name:"WAIT_KEY", kind:"secret", value:KEY }];
    const done = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_wait_writer", { runId:"run-s", timeoutSec:5 }, { threadId:pmThreadId, projectId })));
    expect(done.state).toBe("accepted");
    expect(spawned).toBe(1);
    expect(sandboxCalls[0]!.env).toEqual({ WAIT_KEY:KEY });
    // Neither the answer to the PM, nor a message, nor a stored receipt, nor the database holds the value.
    const everything = [JSON.stringify(done), ...messages, ...written.values(), JSON.stringify(db.prepare("SELECT * FROM lane_pilot_stage_receipt").all()),
      JSON.stringify(db.prepare("SELECT * FROM lane_pilot_attempt").all()), JSON.stringify(db.prepare("SELECT * FROM lane_pilot_project_settings").all())].join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).toContain("using ***");
    await harness.lifecycle.dispose();
  }, 30_000);
});
