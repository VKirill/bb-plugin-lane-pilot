import { countAttempts } from "../src/database";
import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "../server";
import {
  createAttempt,
  createRun,
  createTask,
  closeRun,
  getAttempt,
  getRun,
  getReasoningTrace,
  listAttemptsForTask,
  listStageReceipts,
  openDatabase,
  savePrototypeConfig,
  saveProjectSetting,
  setAttemptDirtBefore,
  setRunThread,
  transitionAttempt,
} from "../src/database";
import type { TaskV2 } from "../src/contracts";
import { validateAcceptanceV2 } from "../src/acceptance-v2";
import { familyDirtBaseline } from "../src/server/writer/verify";

// An in-place redispatch counts only the edits an earlier attempt of the same task family produced; owner or
// other-task dirt in an owned file keeps its baseline and is never counted as produced.
it("releases only family-produced files from the dirt baseline, keeps owner and other-task dirt", () => {
  const contract = { owns_paths:["apps/site/src/"], never_touch:[".git/**"] } as Pick<TaskV2, "owns_paths" | "never_touch">;
  const dirt = [
    { path:"apps/site/src/family-leftover.vue", sha256:"aaa" },
    { path:"apps/site/src/owner-edit.vue", sha256:"bbb" },
    { path:"apps/other/sibling-edit.md", sha256:"ccc" },
    { path:"unowned.txt", sha256:"ddd" },
  ];
  // No earlier attempt of the family produced anything: every pre-existing file keeps its baseline.
  expect(familyDirtBaseline(contract, dirt)).toEqual(dirt);
  // Only the family-produced file leaves the baseline; the owner's edit in the same owned folder, the other task's
  // dirt and the unowned file do not.
  expect(familyDirtBaseline(contract, dirt, new Set(["apps/site/src/family-leftover.vue"]))).toEqual([
    { path:"apps/site/src/owner-edit.vue", sha256:"bbb" },
    { path:"apps/other/sibling-edit.md", sha256:"ccc" },
    { path:"unowned.txt", sha256:"ddd" },
  ]);
  // never_touch files never count as produced, family-produced or not.
  expect(familyDirtBaseline({ owns_paths:["apps/site/src/"], never_touch:[".git/**", "apps/site/src/locked.vue"] }, [
    { path:"apps/site/src/locked.vue", sha256:"eee" },
  ], new Set(["apps/site/src/locked.vue"]))).toEqual([{ path:"apps/site/src/locked.vue", sha256:"eee" }]);
});

const projectId = "project-test";
const pmThreadId = "pm-thread";
// The PM is a root chat (projectId only, no parent/source/owner), as on the hub; writer fakes answer the rest.
const withPm = <A extends { threadId:string }, R>(get:(args:A) => Promise<R>) =>
  async (args:A) => args.threadId === pmThreadId ? { id:pmThreadId, status:"idle", projectId } as never : get(args);
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

function noGitOwnershipBase(method:string) {
  return method==="gitOwnershipBase"
    ? {hostId:"host-test",status:"not-git" as const,branch:null,headSha:null,baseRef:null,baseSha:null,compareCommitted:false,reason:"synthetic fixture is not a git worktree"}
    : null;
}

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

function saveLegacyWriterConfig(db: ReturnType<typeof openDatabase>): void {
  savePrototypeConfig(db, config);
  saveProjectSetting(db, projectId, "plan_critique.enabled", false);
  // These tests follow the writer alone; memory (on by default) would add its maintainer after acceptance.
  saveProjectSetting(db, projectId, "memory.enabled", false);
}

const listLiveWriterProviders = async () => [{ id:"codex", available:true, capabilities:{ supportsServiceTier:true }, serviceTiers:[
  { id:"default", label:"Default" }, { id:"fast", label:"Fast" },
] }] as never;
const listLiveWriterModels = async () => ({ models:[{
  id:"codex-test", model:"codex-test",
  supportedReasoningEfforts:["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })),
}] as never });

describe("BB writer validation on the server path", () => {
  it("returns dispatch immediately and exposes the persisted receipt through bounded wait", async () => {
    let releaseWait!: (value:{matched:boolean; thread:{status:string}}) => void;
    let snapshots = 0;
    let writerIdle = false;
    const taskWorkspace = config.writerWorkspacePath;
    const cwdCalls:string[] = [];
    const fileRoots:string[] = [];
    let spawnedInput:Record<string, unknown>|null = null;
    const delayed = new Promise<{matched:boolean; thread:{status:string}}>((resolve) => { releaseWait = resolve; });
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{ threads:{
        getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
          ? { role:"pm", lanePilotRunId:"run-delayed" }
          : { role:"writer" },
        spawn: async (input) => {
          spawnedInput = input as unknown as Record<string, unknown>;
          expect(input.environment).toMatchObject({ workspace:{ type:"unmanaged", path:taskWorkspace } });
          return { id:"writer-delayed" };
        },
        wait: async () => delayed,
        get: withPm(async () => ({ id:"writer-delayed", status:writerIdle ? "idle" : "active" })),
        output: async () => ({ text:"writer output" }),
        list: async () => [] as never,
      }, providers:{
        list:listLiveWriterProviders,
        models:async () => ({ models:[{ id:"codex-test", model:"codex-test", supportedReasoningEfforts:["medium","high","xhigh"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })) }] as never }),
      }, files:{
        read: async ({ path, rootPath }) => {
          fileRoots.push(rootPath ?? "");
          return path.endsWith("README.md") ? { content:"task read-first fixture\n" }
            : path.endsWith("hello.txt") ? { content:"hello\n" } : { content:null };
        },
        write: async ({ rootPath }) => { fileRoots.push(rootPath ?? ""); return { ok:true }; },
      } },
      experimental_callHostRpc: (call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method === "classifyPlan") {
          const plan = (call.input as { plan:string }).plan;
          return { hostId:"host-test", status:"ok", effort:"xhigh", reason:null,
            planSha256:createHash("sha256").update(plan, "utf8").digest("hex"), sentPlanSha256:createHash("sha256").update(plan, "utf8").digest("hex"),
            sourceLength:Buffer.byteLength(plan), sentLength:Buffer.byteLength(plan) };
        }
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        cwdCalls.push(String((call.input as { cwd?:string }).cwd ?? ""));
        const command = String((call.input as { command?:string }).command ?? "");
        return { hostId:"host-test", exitCode:0, stdout:command.includes("porcelain")
          ? JSON.stringify(++snapshots === 1 ? [] : [{ path:"hello.txt", sha256:"written" }]) : "", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "writer.service_tier", "fast");
    createRun(db, "run-delayed", projectId, "bb", taskWorkspace);
    savePrototypeConfig(db, { ...config, writerWorkspacePath:"/tmp/changed-after-run-start" });
    setRunThread(db, "run-delayed", pmThreadId);
    await plugin(bb);
    const beforeRejected = db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE run_id='run-delayed'").get() as {count:number};
    const rejected = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Canonical plan for workspace rejection", task:{ ...task, id:"wrong-workspace", project_cwd:"/tmp/ag235-writer-fixture" } },
      { threadId:pmThreadId, projectId },
    )));
    expect(rejected).toMatchObject({ state:"rejected", unapplied:[{ key:"task.project_cwd" }] });
    expect(String(rejected.reason)).toContain("must equal the configured writerWorkspacePath");
    expect((db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE run_id='run-delayed'").get() as {count:number}).count).toBe(beforeRejected.count);
    expect((db.prepare("SELECT COUNT(*) count FROM lane_pilot_task WHERE run_id='run-delayed'").get() as {count:number}).count).toBe(0);
    const startedAt = Date.now();
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Canonical delayed writer plan. Keep all Unicode 🧭 and newline. CRITICAL_TAIL", task:{ ...task, id:"delayed-task", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(dispatched).toMatchObject({ runId:"run-delayed", state:"queued", attemptId:expect.any(String), writerThreadId:null });
    const stillRunning = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:"run-delayed", timeoutSec:1 }, { threadId:pmThreadId, projectId },
    )));
    writerIdle = true;
    releaseWait({ matched:true, thread:{ status:"idle" } });
    expect(stillRunning).toMatchObject({ state:"running", attemptId:dispatched.attemptId, writerThreadId:"writer-delayed" });
    const completed = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:"run-delayed", timeoutSec:2 }, { threadId:pmThreadId, projectId },
    )));
    expect(completed).toMatchObject({ state:"accepted", receipt:{ lanePilotRunId:"run-delayed", attemptId:dispatched.attemptId } });
    expect(spawnedInput).toMatchObject({ providerId:"codex", model:"codex-test", reasoningLevel:"xhigh", serviceTier:"fast", executionInputSources:{ reasoningLevel:"client-preference", serviceTier:"explicit" } });
    const fullPlan = "Canonical delayed writer plan. Keep all Unicode 🧭 and newline. CRITICAL_TAIL";
    expect(completed.receipt.reasoning[0]).toMatchObject({
      planSha256:createHash("sha256").update(fullPlan, "utf8").digest("hex"),
      sourceLength:Buffer.byteLength(fullPlan), sentLength:Buffer.byteLength(fullPlan),
      jevDecision:"xhigh", requestedReasoningLevel:"xhigh", effectiveReasoningLevel:"xhigh", threadId:"writer-delayed",
      serviceTier:"fast", requestedServiceTier:"fast",
    });
    // Two dirt snapshots plus the task-folder exclude shell, which reaches the host as a runCommand.
    expect(cwdCalls.length).toBeGreaterThanOrEqual(2);
    expect(fileRoots.every((root) => root === taskWorkspace)).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("uses the explicit manual reasoning fallback when the classifier RPC itself rejects", async () => {
    let snapshots = 0;
    let spawnedInput:Record<string, unknown>|null = null;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata:async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-classifier-rpc-failure" }
            : { role:"writer" },
          spawn:async (input) => { spawnedInput = input as unknown as Record<string, unknown>; return { id:"writer-classifier-rpc-failure" }; },
          wait:async () => ({ matched:true, thread:{ status:"idle" } }),
          get:withPm(async () => ({ id:"writer-classifier-rpc-failure", status:"idle" })),
          output:async () => ({ text:"created hello.txt" }),
          list:async () => [] as never,
        },
        providers:{ list:listLiveWriterProviders, models:async () => ({ models:[{ id:"codex-test", model:"codex-test", supportedReasoningEfforts:["medium","high"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })) }] as never }) },
        files:{
          read:async ({ path }) => path.endsWith("README.md") ? { content:"task read-first fixture\n" }
            : path.endsWith("hello.txt") ? { content:"hello\n" } : { content:null },
          write:async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc:(call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method === "classifyPlan") throw new Error("RPC transport failed");
        if (call.method !== "runCommand") throw new Error(`unexpected host method ${call.method}`);
        const command = String((call.input as { command?:string }).command ?? "");
        if (command.includes("porcelain")) {
          snapshots += 1;
          return { hostId:"host-test", exitCode:0, stdout:JSON.stringify(snapshots === 1 ? [] : [{ path:"hello.txt", sha256:"new-file" }]), stderr:"" };
        }
        return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "writer.reasoning_effort", "high");
    createRun(db, "run-classifier-rpc-failure", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-classifier-rpc-failure", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Complete plan for RPC fallback test", task:{ ...task, id:"rpc-fallback-task", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    expect(dispatched.state).toBe("queued");
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:"run-classifier-rpc-failure", timeoutSec:2 }, { threadId:pmThreadId, projectId },
    )));
    expect(result.state).toBe("accepted");
    expect(spawnedInput).toMatchObject({ providerId:"codex", model:"codex-test", reasoningLevel:"high", executionInputSources:{ reasoningLevel:"explicit" } });
    expect(getReasoningTrace(db, dispatched.attemptId)).toMatchObject({
      jevStatus:"error", jevDecision:null, effectiveReasoningLevel:"high", fallbackReason:"jev_error;host_classify_rpc_failed", sentPlanSha256:null, sentLength:null,
    });
    await harness.lifecycle.dispose();
  });

  it("accepts a resumed attempt whose worktree holds Lane Pilot's own receipt from the pass a reload cut off (live: gc-hub-port-full.2)", async () => {
    let snapshots = 0;
    const receipt = ".agents/runs/run-resumed-receipt/artifacts/resumed-task/acceptance.json";
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata:async ({ threadId }) => threadId === pmThreadId ? { role:"pm", lanePilotRunId:"run-resumed-receipt" } : { role:"writer" },
          spawn:async () => ({ id:"writer-resumed-receipt" }),
          wait:async () => ({ matched:true, thread:{ status:"idle" } }),
          get:withPm(async () => ({ id:"writer-resumed-receipt", status:"idle" })),
          output:async () => ({ text:"created hello.txt" }),
          list:async () => [] as never,
        },
        providers:{ list:listLiveWriterProviders, models:listLiveWriterModels },
        files:{
          read:async ({ path }) => path.endsWith("README.md") ? { content:"task read-first fixture\n" }
            : path.endsWith("hello.txt") ? { content:"hello\n" } : { content:null },
          write:async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc:(call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method === "classifyPlan") throw new Error("RPC transport failed");
        const command = String((call.input as { command?:string }).command ?? "");
        if (command.includes("porcelain")) {
          snapshots += 1;
          return { hostId:"host-test", exitCode:0, stdout:JSON.stringify(snapshots === 1 ? []
            : [{ path:"hello.txt", sha256:"new-file" }, { path:receipt, sha256:"receipt" }]), stderr:"" };
        }
        return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    createRun(db, "run-resumed-receipt", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-resumed-receipt", pmThreadId);
    await plugin(bb);
    await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Complete plan for resumed receipt test", task:{ ...task, id:"resumed-task", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    );
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:"run-resumed-receipt", timeoutSec:2 }, { threadId:pmThreadId, projectId },
    )));
    expect(listAttemptsForTask(db, "run-resumed-receipt", "resumed-task").map((row) => getAttempt(db, row.id)?.reason ?? null)).toEqual([null]);
    expect(result.state).toBe("accepted");
    await harness.lifecycle.dispose();
  });

  it("sends a task whose depends_on is already blocked back to the PM to replan instead of queuing it (live: gc-native-price-watermark.4)", async () => {
    let spawns = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata:async ({ threadId }) => threadId === pmThreadId ? { role:"pm", lanePilotRunId:"run-depends" } : { role:"writer" },
          spawn:async () => { spawns += 1; return { id:"writer-depends" }; },
          get:withPm(async () => ({ id:"writer-depends", status:"idle" })),
          list:async () => [] as never,
        },
        providers:{ list:listLiveWriterProviders, models:listLiveWriterModels },
        files:{ read:async () => ({ content:"task read-first fixture\n" }), write:async () => ({ ok:true }) },
      },
      experimental_callHostRpc:(call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        return { hostId:"host-test", exitCode:0, stdout:"[]", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    createRun(db, "run-depends", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-depends", pmThreadId);
    createTask(db, { id:"dep-task", runId:"run-depends", kind:"bb", contract:{ ...task, id:"dep-task" } });
    createAttempt(db, { id:"dep-attempt", runId:"run-depends", taskId:"dep-task" });
    transitionAttempt(db, "dep-attempt", "blocked", { reason:"retry limit 2 exhausted" });
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Plan that waits for dep-task", task:{ ...task, id:"dependent", depends_on:["dep-task"], verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    // The contract lint sends the PM back to replan: no task, no attempt, no cascade of blocked receipts.
    expect(dispatched).toMatchObject({ state:"validation_failed", replan:true });
    expect(dispatched.reason).toContain("replan: depends_on dep-task ended blocked");
    expect(listStageReceipts(db, "run-depends", "dependent")).toEqual([]);
    expect(spawns).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("stops on a writer's NEEDS_HUMAN question without retry and hands the question to the PM", async () => {
    let spawns = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata:async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-needs-human" }
            : { role:"writer" },
          spawn:async () => { spawns += 1; return { id:`writer-needs-human-${spawns}` }; },
          wait:async () => ({ matched:true, thread:{ status:"idle" } }),
          get:withPm(async () => ({ id:"writer-needs-human-1", status:"idle" })),
          output:async () => ({ text:"NEEDS_HUMAN: Which pricing plan should the landing show, Pro or Team?\nI changed nothing." }),
          list:async () => [] as never,
        },
        providers:{ list:listLiveWriterProviders, models:async () => ({ models:[{ id:"codex-test", model:"codex-test", supportedReasoningEfforts:["medium","high"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })) }] as never }) },
        files:{
          read:async ({ path }) => path.endsWith("README.md") ? { content:"task read-first fixture\n" } : { content:null },
          write:async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc:(call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method === "classifyPlan") throw new Error("RPC transport failed");
        if (call.method !== "runCommand") throw new Error(`unexpected host method ${call.method}`);
        const command = String((call.input as { command?:string }).command ?? "");
        if (command.includes("porcelain")) return { hostId:"host-test", exitCode:0, stdout:"[]", stderr:"" };
        return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "writer.reasoning_effort", "high");
    createRun(db, "run-needs-human", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-needs-human", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Complete plan for the needs-human test", task:{ ...task, id:"needs-human-task", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    expect(dispatched.state).toBe("queued");
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:"run-needs-human", timeoutSec:2 }, { threadId:pmThreadId, projectId },
    )));
    expect(result.state).not.toBe("accepted");
    expect(JSON.stringify(result)).toContain("needs_human: Which pricing plan should the landing show, Pro or Team?");
    expect(spawns).toBe(1);
    const attempts = db.prepare("SELECT state, reason FROM lane_pilot_attempt WHERE run_id='run-needs-human'").all();
    expect(attempts).toEqual([{ state:"blocked", reason:"needs_human: Which pricing plan should the landing show, Pro or Team?" }]);
    await harness.lifecycle.dispose();
  });

  it.each([
    { jev:"ok" as const, expected:["Run every npm verification command before answering."], skipped:["Check the site healthcheck after every deploy."] },
    { jev:"down" as const, expected:["Run every npm verification command before answering.", "Check the site healthcheck after every deploy."], skipped:[] },
  ])("puts only the accepted rules System One picks for the task into the writer prompt (jev $jev)", async ({ jev, expected, skipped }) => {
    let spawnedPrompt = "";
    const judged: Array<Record<string, unknown>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata:async ({ threadId }) => threadId === pmThreadId ? { role:"pm", lanePilotRunId:"run-rules" } : { role:"writer" },
          spawn:async (input) => { spawnedPrompt = String((input as { prompt?:string }).prompt ?? ((input as { input?:Array<{ text?:string }> }).input ?? []).map((part) => part.text ?? "").join("\n\n")); return { id:"writer-rules" }; },
          wait:async () => ({ matched:true, thread:{ status:"idle" } }),
          get:withPm(async () => ({ id:"writer-rules", status:"idle" })),
          output:async () => ({ text:"NEEDS_HUMAN: stop here, the test only needs the prompt" }),
          list:async () => [] as never,
        },
        providers:{ list:listLiveWriterProviders, models:async () => ({ models:[{ id:"codex-test", model:"codex-test", supportedReasoningEfforts:["medium","high"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })) }] as never }) },
        files:{ read:async ({ path }) => path.endsWith("README.md") ? { content:"fixture\n" } : { content:null }, write:async () => ({ ok:true }) },
      },
      experimental_callHostRpc:(call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method === "classifyPlan") throw new Error("RPC transport failed");
        if (call.method === "councilJudge") {
          judged.push(call.input as Record<string, unknown>);
          if (jev === "down") return { hostId:"host-test", status:"disabled", answers:{}, reason:"missing_typesafe_api_key" };
          return { hostId:"host-test", status:"ok", reason:null, answers:{ r1:"yes", r2:"no" }, confidence:{ r1:0.95, r2:0.9 },
            probabilities:{ r1:{ yes:0.95, no:0.05 }, r2:{ yes:0.02, no:0.98 } } };
        }
        if (call.method !== "runCommand") throw new Error(`unexpected host method ${call.method}`);
        const command = String((call.input as { command?:string }).command ?? "");
        if (command.includes("porcelain")) return { hostId:"host-test", exitCode:0, stdout:"[]", stderr:"" };
        return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "writer.reasoning_effort", "high");
    saveProjectSetting(db, projectId, "memory.enabled", "true");
    saveProjectSetting(db, projectId, "memory.inject", "true");
    ["Run every npm verification command before answering.", "Check the site healthcheck after every deploy."].forEach((rule, index) => {
      db.prepare("INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(`mem-${index}`, projectId, "", "core", "subagent", rule, '["rule"]', "s", index);
      db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at)
        VALUES (?,?,?,?,'owner','accepted',3,3,'[]',?,1,1,1,?)`).run(`rule-${index}`, projectId, `s${index}`, rule, `mem-${index}`, index);
    });
    // A PM's rule never reaches a writer; a rule for every task reaches it without a question to System One.
    [["rule-pm", "Write owns_paths with every sibling test.", "pm", 0], ["rule-always", "Never read the exit code after a pipe.", "writer", 1]].forEach(([id, rule, audience, always], index) => {
      db.prepare("INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(`mem-${id}`, projectId, "", "core", "subagent", rule, '["rule"]', "s", 5 + index);
      db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,audience,always_on)
        VALUES (?,?,?,?,'pm','accepted',1,0,'[]',?,1,1,1,?,?,?)`).run(id, projectId, `s-${id}`, rule, `mem-${id}`, 5 + index, audience, always);
    });
    // A rule from another section of the project (another client) must never reach this run's writer.
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at) VALUES('mem-other',?,'','core','subagent','Other client rule.','[]','s',9)").run(projectId);
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,scope_json)
      VALUES ('rule-other',?,'s9','Other client rule.','model','accepted',3,3,'[]','mem-other',1,1,1,9,'["section:clients","section:other-client"]')`).run(projectId);
    createRun(db, "run-rules", projectId, "bb", config.writerWorkspacePath);
    db.prepare("UPDATE lane_pilot_run SET settings_scopes_json=? WHERE id='run-rules'").run(JSON.stringify(["section:clients", "section:this-client"]));
    setRunThread(db, "run-rules", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Plan for the rules test", task:{ ...task, id:`rules-task-${jev}`, verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    await harness.behavior.callAgentTool("lane_pilot_wait_writer", { runId:"run-rules", timeoutSec:2 }, { threadId:pmThreadId, projectId });
    expect(judged).toHaveLength(1);
    expect(Object.keys(judged[0]!.questions as object)).toEqual(["r1", "r2"]);
    for (const rule of expected) expect(spawnedPrompt).toContain(rule);
    for (const rule of skipped) expect(spawnedPrompt).not.toContain(rule);
    expect(spawnedPrompt).not.toContain("Other client rule.");
    expect(spawnedPrompt).not.toContain("Write owns_paths with every sibling test.");
    expect(spawnedPrompt).toContain("Never read the exit code after a pipe.");
    expect(getReasoningTrace(db, dispatched.attemptId)?.dispatchContext?.rulesPicked).toEqual({ total:4, picked:jev === "ok" ? ["rule-0", "rule-always"] : ["rule-0", "rule-1", "rule-always"] });
    await harness.lifecycle.dispose();
  });

  it("escalates a retry from the first effort and stores the applied choice in its receipt", async () => {
    let snapshots=0;
    const spawned:Array<Record<string,unknown>>=[];
    let threadNo=0;
    const {bb,harness}=createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{threads:{
        getPluginMetadata:async ({threadId})=>threadId===pmThreadId?{role:"pm",lanePilotRunId:"run-effort-retry"}:{role:"writer"},
        spawn:async (input)=>{spawned.push(input as unknown as Record<string,unknown>);return {id:`writer-retry-${++threadNo}`};},
        wait:async ()=>({matched:true,thread:{status:threadNo===1?"error":"idle"}}),
        get:withPm(async ({threadId})=>({id:threadId,status:threadId==="writer-retry-1"?"error":"idle"})),
        output:async ()=>({text:"created hello.txt"}),list:async ()=>[] as never,
      },providers:{list:listLiveWriterProviders,models:listLiveWriterModels},files:{
        read:async ({path})=>path.endsWith("README.md")?{content:"retry fixture\n"}:path.endsWith("hello.txt")?{content:"hello\n"}:{content:null},
        write:async ()=>({ok:true}),
      }},
      experimental_callHostRpc:(call)=>{
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if(call.method==="classifyPlan"){
          const plan=(call.input as {plan:string}).plan;
          const sha=createHash("sha256").update(plan,"utf8").digest("hex");
          return {hostId:"host-test",status:"ok",effort:"medium",reason:null,planSha256:sha,sentPlanSha256:sha,
            sourceLength:Buffer.byteLength(plan),sentLength:Buffer.byteLength(plan)};
        }
        if(call.method!=="runCommand") throw new Error(`unexpected ${call.method}`);
        const command=String((call.input as {command?:string}).command??"");
        return {hostId:"host-test",exitCode:0,stdout:command.includes("porcelain")
          ?JSON.stringify(++snapshots<=2?[]:[{path:"hello.txt",sha256:"created"}]):"",stderr:""};
      },
    });
    const db=openDatabase(bb);
    saveLegacyWriterConfig(db);
    createRun(db,"run-effort-retry",projectId,"bb",config.writerWorkspacePath);
    setRunThread(db,"run-effort-retry",pmThreadId);
    await plugin(bb);
    const dispatched=JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
      {confirm:true,plan:"Retry effort escalation fixture",task:{...task,id:"effort-retry-task",verify:"none",verification:[]}},
      {threadId:pmThreadId,projectId}))) as {runId:string;attemptId:string};
    const result=JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_wait_writer",
      {runId:dispatched.runId,timeoutSec:3},{threadId:pmThreadId,projectId})));
    const attempts=listAttemptsForTask(db,dispatched.runId,"effort-retry-task");
    expect(result.state).toBe("accepted");
    expect(attempts.map(row=>row.state)).toEqual(["provider_error","accepted"]);
    expect(spawned.map(row=>row.reasoningLevel)).toEqual(["medium","high"]);
    expect(getReasoningTrace(db,attempts[1]!.id)).toMatchObject({
      requestedReasoningLevel:"medium",effectiveReasoningLevel:"high",fallbackReason:"retry_effort_escalated:medium->high",
      retryEffort:{enabled:true,retryIndex:1,before:"medium",after:"high",changed:true},
    });
    await harness.lifecycle.dispose();
  });

  it("dispatches saved high in manual mode even when Jev answers low", async () => {
    let classifyCalls=0;
    let snapshots=0;
    let spawnedInput:Record<string,unknown>|null=null;
    const {bb,harness}=createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{threads:{
        getPluginMetadata:async ({threadId})=>threadId===pmThreadId?{role:"pm",lanePilotRunId:"run-manual-high"}:{role:"writer"},
        spawn:async (input)=>{spawnedInput=input as unknown as Record<string,unknown>;return {id:"writer-manual-high"};},
        wait:async ()=>({matched:true,thread:{status:"idle"}}),
        get:withPm(async ({threadId})=>({id:threadId,status:"idle"})),
        output:async ()=>({text:"created hello.txt"}),list:async ()=>[] as never,
      },providers:{list:listLiveWriterProviders,models:listLiveWriterModels},files:{
        read:async ({path})=>path.endsWith("README.md")?{content:"manual high fixture\n"}:path.endsWith("hello.txt")?{content:"hello\n"}:{content:null},
        write:async ()=>({ok:true}),
      }},
      experimental_callHostRpc:(call)=>{
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if(call.method==="classifyPlan"){
          classifyCalls+=1;
          const plan=(call.input as {plan:string}).plan;
          const sha=createHash("sha256").update(plan,"utf8").digest("hex");
          return {hostId:"host-test",status:"ok",effort:"low",reason:null,planSha256:sha,sentPlanSha256:sha,
            sourceLength:Buffer.byteLength(plan),sentLength:Buffer.byteLength(plan)};
        }
        if(call.method!=="runCommand") throw new Error(`unexpected ${call.method}`);
        const command=String((call.input as {command?:string}).command??"");
        return {hostId:"host-test",exitCode:0,stdout:command.includes("porcelain")
          ?JSON.stringify(++snapshots===1?[]:[{path:"hello.txt",sha256:"created"}]):"",stderr:""};
      },
    });
    const db=openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    saveProjectSetting(db, projectId, "writer.reasoning_effort", "high");
    createRun(db,"run-manual-high",projectId,"bb",config.writerWorkspacePath);
    setRunThread(db,"run-manual-high",pmThreadId);
    await plugin(bb);
    const dispatched=JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
      {confirm:true,plan:"Manual high must survive a low classifier answer",task:{...task,id:"manual-high-task",verify:"none",verification:[]}},
      {threadId:pmThreadId,projectId}))) as {attemptId:string};
    await harness.behavior.callAgentTool("lane_pilot_wait_writer",{runId:"run-manual-high",timeoutSec:3},{threadId:pmThreadId,projectId});
    expect(classifyCalls).toBe(0);
    expect(spawnedInput).toMatchObject({reasoningLevel:"high",executionInputSources:{reasoningLevel:"explicit"}});
    expect(getReasoningTrace(db, dispatched.attemptId)).toMatchObject({
      effortMode:"manual", effectiveReasoningLevel:"high", jevStatus:"disabled",
      selectionSource:{reasoningLevel:"high",reasoningLevelSource:"explicit"},
    });
    expect(listStageReceipts(db,"run-manual-high","manual-high-task").find((row)=>row.stageId==="writer-agent")?.result)
      .toMatchObject({execution:{reasoningLevel:"high",selectionSource:{reasoningLevelSource:"explicit"}}});
    await harness.lifecycle.dispose();
  });

  it("records automatic low with a reason when Jev overrides a saved high", async () => {
    let snapshots=0;
    let spawnedInput:Record<string,unknown>|null=null;
    const {bb,harness}=createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{threads:{
        getPluginMetadata:async ({threadId})=>threadId===pmThreadId?{role:"pm",lanePilotRunId:"run-auto-low"}:{role:"writer"},
        spawn:async (input)=>{spawnedInput=input as unknown as Record<string,unknown>;return {id:"writer-auto-low"};},
        wait:async ()=>({matched:true,thread:{status:"idle"}}),
        get:withPm(async ({threadId})=>({id:threadId,status:"idle"})),
        output:async ()=>({text:"created hello.txt"}),list:async ()=>[] as never,
      },providers:{list:listLiveWriterProviders,models:listLiveWriterModels},files:{
        read:async ({path})=>path.endsWith("README.md")?{content:"automatic low fixture\n"}:path.endsWith("hello.txt")?{content:"hello\n"}:{content:null},
        write:async ()=>({ok:true}),
      }},
      experimental_callHostRpc:(call)=>{
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if(call.method==="classifyPlan"){
          const plan=(call.input as {plan:string}).plan;
          const sha=createHash("sha256").update(plan,"utf8").digest("hex");
          return {hostId:"host-test",status:"ok",effort:"medium",reason:null,planSha256:sha,sentPlanSha256:sha,
            sourceLength:Buffer.byteLength(plan),sentLength:Buffer.byteLength(plan)};
        }
        if(call.method!=="runCommand") throw new Error(`unexpected ${call.method}`);
        const command=String((call.input as {command?:string}).command??"");
        return {hostId:"host-test",exitCode:0,stdout:command.includes("porcelain")
          ?JSON.stringify(++snapshots===1?[]:[{path:"hello.txt",sha256:"created"}]):"",stderr:""};
      },
    });
    const db=openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", true);
    saveProjectSetting(db, projectId, "writer.reasoning_effort", "high");
    createRun(db,"run-auto-low",projectId,"bb",config.writerWorkspacePath);
    setRunThread(db,"run-auto-low",pmThreadId);
    await plugin(bb);
    const dispatched=JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
      {confirm:true,plan:"Automatic mode may choose a cheaper level",task:{...task,id:"auto-low-task",verify:"none",verification:[]}},
      {threadId:pmThreadId,projectId}))) as {attemptId:string};
    await harness.behavior.callAgentTool("lane_pilot_wait_writer",{runId:"run-auto-low",timeoutSec:3},{threadId:pmThreadId,projectId});
    expect(spawnedInput).toMatchObject({reasoningLevel:"medium",executionInputSources:{reasoningLevel:"client-preference"}});
    expect(getReasoningTrace(db, dispatched.attemptId)).toMatchObject({
      effortMode:"automatic", requestedReasoningLevel:"medium", effectiveReasoningLevel:"medium", jevStatus:"ok",
      selectionSource:{reasoningLevel:"medium",reasoningLevelSource:"client-preference"},
    });
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
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
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
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
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
          get: async ({ threadId }) => threadId === pmThreadId
            ? { id:pmThreadId, status:"idle", projectId, sourceThreadId:pmThreadId, lifecycleOwnerThreadId:pmThreadId }
            : { id:"writer-accepted", status:"idle" },
          output: async () => ({ text:"writer output" }),
          list: async () => [] as never,
        },
        providers:{ list:listLiveWriterProviders, models:listLiveWriterModels },
        files:{
          read: async ({ path }) => path.endsWith("README.md") ? { content:"task read-first fixture\n" }
            : path.endsWith("hello.txt") ? { content:"hello\n" } : { content:null },
          write: async ({ path, content }) => {
            written.set(String(path), String(content));
            return { ok:true };
          },
        },
      },
      experimental_callHostRpc: (call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        const command = String((call.input as { command?:string }).command ?? "");
        if (command.includes("porcelain")) {
          snapshots += 1;
          return {
            hostId:"host-test", exitCode:0,
            stdout:JSON.stringify(snapshots % 2 === 1 ? [] : [{ path:"hello.txt", sha256:"new-content" }]),
            stderr:"",
          };
        }
        return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    createRun(db, "run-accepted", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-accepted", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Canonical accepted writer plan", task:{ ...task, id:"accepted-task", verify:"none", verification:[] } },
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

    // A second task in the same run must not replace the first task's receipt in the PM's answer.
    await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Second accepted writer plan", task:{ ...task, id:"accepted-task-2", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    );
    const both = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:"run-accepted", timeoutSec:2 }, { threadId:pmThreadId, projectId },
    )));
    expect(both.state).toBe("accepted");
    expect(both.receipt.tasks.map((item:{lanePilotTaskId:string}) => item.lanePilotTaskId).sort()).toEqual(
      (db.prepare("SELECT id FROM lane_pilot_task WHERE run_id='run-accepted'").all() as {id:string}[]).map((row) => row.id).sort(),
    );
    await harness.lifecycle.dispose();
  });

  it("runs every verification command and fails on the second", async () => {
    const ran: string[] = [];
    let snapshots = 0;
    let activeVerifications=0;
    let maxActiveVerifications=0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-v" }
            : { role:"writer" },
          spawn: async () => ({ id:"writer-real" }),
          wait: async () => ({ matched:true, thread:{ status:"idle" } }),
          get: withPm(async () => ({ id:"writer-real", status:"idle" })),
          output: async () => ({ text:"ok" }),
          list: async () => [] as never,
        },
        providers:{ list:listLiveWriterProviders, models:listLiveWriterModels },
        files:{
          read: async ({ path }) => path.endsWith("README.md") ? { content:"task read-first fixture\n" }
            : path.endsWith("hello.txt") ? { content:"hello\n" } : { content:null },
          write: async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc: async (call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method === "runSandboxedCommand") {
          const command = String((call.input as { command?:string }).command ?? "");
          ran.push(command);
          activeVerifications++;
          maxActiveVerifications=Math.max(maxActiveVerifications,activeVerifications);
          await new Promise(resolve=>setTimeout(resolve,20));
          activeVerifications--;
          return {hostId:"host-test",backend:"macos-seatbelt",workspacePath:task.project_cwd,cwd:task.project_cwd,
            exitCode:command === "false" ? 1 : 0,policySha256:"d".repeat(64),stdout:"",stderr:command === "false" ? "boom" : ""};
        }
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
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    saveProjectSetting(db, projectId, "ops.verify_pool_size", 2);
    createRun(db, "run-v", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-v", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Canonical verification plan", task },
      { threadId:pmThreadId, projectId },
    )));
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:dispatched.runId, timeoutSec:3 }, { threadId:pmThreadId, projectId },
    )));
    // A failing check runs once more before it counts as failed. One writer session: the failure goes back to the same
    // writer as feedback turns (this fake's diff changes on turns 1-3, then repeats with the same failure on turn 4,
    // which ends the session), so the three commands run four times instead of twice.
    expect(ran.filter((command) => command === "true" || command === "false")).toEqual(
      Array.from({ length:4 }, () => ["true", "false", "false"]).flat());
    expect(maxActiveVerifications).toBe(2);
    expect(JSON.parse(getRun(db,"run-v")!.run_policy_json)).toMatchObject({pools:{verification:2}});
    expect(result.state).toBe("blocked");
    await harness.lifecycle.dispose();
  });

  it("runs verification in a BB terminal of the writer thread, with the sandbox line and its release", async () => {
    const created: Array<{ scope:unknown; command:string }> = [];
    const released: string[] = [];
    let snapshots = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }: { threadId:string }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-t" }
            : { role:"writer" },
          spawn: async () => ({ id:"writer-real" }),
          wait: async () => ({ matched:true, thread:{ status:"idle" } }),
          get: withPm(async () => ({ id:"writer-real", status:"idle" })),
          output: async () => ({ text:"ok" }),
          list: async () => [] as never,
        },
        terminals:{
          create: async (input: { scope:unknown; start:{ command:string } }) => {
            created.push({ scope:input.scope, command:input.start.command });
            return { id:`term-${created.length}`, status:"running" };
          },
          get: async ({ terminalId }: { terminalId:string }) => {
            const command = created[Number(terminalId.slice(5)) - 1]!.command;
            return { id:terminalId, status:"exited", exitCode:command.includes("'false'") ? 1 : 0 };
          },
          output: async () => ({ chunks:[{ dataBase64:Buffer.from("check output").toString("base64") }] }),
          close: async () => ({ ok:true }),
        },
        providers:{ list:listLiveWriterProviders, models:listLiveWriterModels },
        files:{
          read: async ({ path }: { path:string }) => path.endsWith("README.md") ? { content:"task read-first fixture\n" }
            : path.endsWith("hello.txt") ? { content:"hello\n" } : { content:null },
          write: async () => ({ ok:true }),
        },
      } as never,
      experimental_callHostRpc: async (call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method === "runSandboxedCommand") throw new Error("verification must not bypass the terminal");
        if (call.method === "sandboxCommandLine") {
          const command = String((call.input as { command?:string }).command ?? "");
          return { hostId:"host-test", backend:"macos-seatbelt", workspacePath:task.project_cwd, cwd:task.project_cwd,
            policySha256:"e".repeat(64), commandLine:`exec sandbox '${command}'`, cleanup:{ tempPath:`/tmp/lane-pilot-sandbox-${command}`, created:[] } };
        }
        if (call.method === "sandboxRelease") { released.push(String((call.input as { tempPath:string }).tempPath)); return { hostId:"host-test", released:true }; }
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        const command = String((call.input as { command?:string }).command ?? "");
        if (command.includes("porcelain")) {
          return { hostId:"host-test", exitCode:0, stdout:JSON.stringify(
            ++snapshots === 1 || snapshots === 3 ? [] : [{ path:"hello.txt", sha256:snapshots === 2 ? "attempt-1" : "attempt-2" }],
          ), stderr:"" };
        }
        return { hostId:"host-test", exitCode:0, stdout:"", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    createRun(db, "run-t", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-t", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Canonical verification plan", task },
      { threadId:pmThreadId, projectId },
    )));
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:dispatched.runId, timeoutSec:20 }, { threadId:pmThreadId, projectId },
    )));
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(created[0]!.scope).toEqual({ kind:"thread", threadId:"writer-real" });
    expect(created.map((entry) => entry.command)).toContain("exec sandbox 'false'");
    expect(released).toHaveLength(created.length);
    expect(result.state).toBe("blocked");
    await harness.lifecycle.dispose();
  }, 30_000);

  it("observes writer errors, tries one unavailable emergency selection and returns blocked", async () => {
    const threadStates = new Map<string, string>();
    let spawnCount = 0;
    let statusPollCount = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-v" }
            : { role:"writer" },
          spawn: async () => {
            const id = `writer-error-${++spawnCount}`;
            threadStates.set(id, "active");
            return { id };
          },
          get: withPm(async ({ threadId }) => {
            statusPollCount += 1;
            threadStates.set(threadId, "error");
            return { id:threadId, status:threadStates.get(threadId) ?? "error" };
          }),
          output: async () => ({ text:"ok" }),
          list: async () => [] as never,
        },
        providers:{ list:listLiveWriterProviders, models:listLiveWriterModels },
        files:{
          read: async ({ path }) => path.endsWith("README.md") ? { content:"task read-first fixture\n" } : { content:null },
          write: async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc: (call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method === "runCommand") {
          return { hostId:"host-test", exitCode:0, stdout:"[]", stderr:"" };
        }
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    // This test follows the PM's emergency model alone; the writer's fallbacks are off.
    saveProjectSetting(db, projectId, "writer.fallback1.provider", "");
    saveProjectSetting(db, projectId, "writer.fallback2.provider", "");
    createRun(db, "run-v", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-v", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Canonical retry plan", task:{ ...task, id:"error-retry", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:dispatched.runId, timeoutSec:3 }, { threadId:pmThreadId, projectId },
    )));
    expect(result.state).toBe("blocked");
    expect(spawnCount).toBe(2);
    expect(statusPollCount).toBeGreaterThanOrEqual(2);
    expect(listAttemptsForTask(db, dispatched.runId, "error-retry").map((attempt) => attempt.state)).toEqual(["provider_error", "blocked", "blocked"]);
    expect(listStageReceipts(db,dispatched.runId,"error-retry").find((row)=>row.stageId==="writer-agent")?.result).toMatchObject({
      emergencyFallback:{state:"failed",reason:"writer_provider_unavailable:claude-code"},
    });
    expect(getRun(db, dispatched.runId)?.state).toBe("blocked");
    await harness.lifecycle.dispose();
  });

  it("marks an unexpected background writer exception terminal and releases the task", async () => {
    let statusUnavailable = true;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{ threads:{
        getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
          ? { role:"pm", lanePilotRunId:"run-background-error" }
          : { role:"writer" },
        spawn: async () => ({ id:"writer-background-error" }),
        get: withPm(async () => statusUnavailable
          ? new Promise<never>(() => {})
          : ({ id:"writer-background-error", status:"idle" })),
        output: async () => { throw new Error("synthetic output read failure"); },
        list: async () => [] as never,
      }, providers:{ list:listLiveWriterProviders, models:listLiveWriterModels },
      files:{ read:async ({path})=>path.endsWith("README.md")?{content:"task read-first fixture\n"}:{content:null}, write:async () => ({ ok:true }) } },
      experimental_callHostRpc: (call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        return { hostId:"host-test", exitCode:0, stdout:"[]", stderr:"" };
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    createRun(db, "run-background-error", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-background-error", pmThreadId);
    await plugin(bb);

    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Canonical background error plan", task:{ ...task, id:"background-error-task", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    expect(dispatched.state).toBe("queued");
    const stillRunning = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer",
      { runId:dispatched.runId, timeoutSec:1 },
      { threadId:pmThreadId, projectId },
    )));
    expect(stillRunning).toMatchObject({ state:"running", attemptId:dispatched.attemptId });
    statusUnavailable = false;
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer",
      { runId:dispatched.runId, timeoutSec:3 },
      { threadId:pmThreadId, projectId },
    )));
    expect(result).toMatchObject({ state:"blocked", reason:expect.stringContaining("internal_error: synthetic output read failure") });
    expect(getAttempt(db, dispatched.attemptId)).toMatchObject({ state:"blocked" });
    expect((db.prepare("SELECT reason FROM lane_pilot_attempt WHERE id=?").get(dispatched.attemptId) as {reason:string}).reason)
      .toContain("internal_error: synthetic output read failure");
    expect(getRun(db, dispatched.runId)?.state).toBe("blocked");
    expect((db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE run_id=? AND state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested')")
      .get(dispatched.runId) as {count:number}).count).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("fails closed when a resumed attempt has a pre-dirty path without a content hash", async () => {
    const resumeTask: TaskV2 = { ...task, id:"resume-task", verify:"none", verification:[] };
    const snapshotCwds:string[] = [];
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
          read: async ({ path }) => path.endsWith("README.md") ? { content:"task read-first fixture\n" }
            : path.endsWith("hello.txt") ? { content:"stale\n" } : { content:null },
          write: async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc: (call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method === "runCommand") {
          snapshotCwds.push(String((call.input as { cwd?:string }).cwd ?? ""));
          return { hostId:"host-test", exitCode:0, stdout:JSON.stringify([{ path:"hello.txt", sha256:"unchanged" }]), stderr:"" };
        }
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    createRun(db, "run-resume", projectId, "bb", config.writerWorkspacePath);
    savePrototypeConfig(db, { ...config, writerWorkspacePath:"/tmp/changed-after-resume-run-start" });
    setRunThread(db, "run-resume", pmThreadId);
    createTask(db, { id:"resume-task", runId:"run-resume", kind:"bb", contract:resumeTask });
    createAttempt(db, { id:"attempt-resume", runId:"run-resume", taskId:"resume-task" });
    transitionAttempt(db, "attempt-resume", "spawn_requested");
    transitionAttempt(db, "attempt-resume", "running", { threadId:"writer-orphan" });
    setAttemptDirtBefore(db, "attempt-resume", ["hello.txt"]);
    await plugin(bb);
    harness.runService("startup-recovery");
    await vi.waitFor(() => expect(getAttempt(db, "attempt-resume")?.state).toBe("validation_failed"));
    // Since 0.1.92 the failed resumed attempt is retried (its start loop died with the reload); every snapshot,
    // the retry's too, runs in the run's own workspace, not the changed project setting.
    await vi.waitFor(() => expect(countAttempts(db, "run-resume", "resume-task")).toBeGreaterThanOrEqual(2));
    expect(new Set(snapshotCwds)).toEqual(new Set([config.writerWorkspacePath]));
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
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
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
          spawn: async (args) => {
            const metadata=args.pluginMetadata as Record<string,unknown>;
            if(metadata.role==="workspace-provisioner") return {id:"workspace-holder",environmentId:"dirt-fail-env"};
            spawnCalled += 1;
            return { id:"writer-should-not-exist" };
          },
          wait: async () => ({ matched:true, thread:{ status:"idle" } }),
          get: async () => ({ id:"writer-should-not-exist", status:"idle" }),
          output: async () => ({ text:"ok" }),
          list: async () => [] as never,
        },
        environments:{get:async ({environmentId})=>({id:environmentId,hostId:config.hostId,path:config.writerWorkspacePath,status:"ready",managed:true,workspaceProvisionType:"managed-worktree"}) as never},
        files:{
          read: async ({ path }) => path.endsWith("README.md") ? { content:"task read-first fixture\n" } : { content:"hello\n" },
          write: async () => ({ ok:true }),
        },
      },
      experimental_callHostRpc: (call) => {
        const gitBase=noGitOwnershipBase(call.method); if(gitBase) return gitBase;
        if (call.method === "runCommand") {
          return { hostId:"host-test", exitCode:1, stdout:"", stderr:"git status failed" };
        }
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    createRun(db, "run-dirt", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-dirt", pmThreadId);
    await plugin(bb);
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Canonical dirty workspace plan", task:{ ...task, id:"dirt-fail", verify:"none", verification:[] } },
      { threadId:pmThreadId, projectId },
    )));
    const result = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer", { runId:dispatched.runId, timeoutSec:3 }, { threadId:pmThreadId, projectId },
    )));
    expect(spawnCalled).toBe(0);
    expect(result.state).toBe("blocked");
    expect(getAttempt(db, dispatched.attemptId)?.state).toBe("blocked");
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
    saveLegacyWriterConfig(db);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    createRun(db, "run-cancel", projectId);
    createAttempt(db, { id:"attempt-cancel", runId:"run-cancel", taskId:"t" });
    transitionAttempt(db, "attempt-cancel", "spawn_requested");
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

  it("rejects terminal and closed cancellation before stop without changing acceptance", async () => {
    let stopCalls = 0;
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{
      stop:async () => { stopCalls++; return { ok:true }; },
    } } });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    createRun(db, "run-terminal-cancel", projectId);
    createAttempt(db, { id:"attempt-terminal-cancel", runId:"run-terminal-cancel", taskId:"t" });
    transitionAttempt(db, "attempt-terminal-cancel", "accepted", { threadId:"writer-accepted" });
    const receipt = { lanePilotRunId:"run-terminal-cancel", status:"accepted", output:"preserve" };
    saveProjectSetting(db, projectId, "writer.lastResult", receipt);
    expect(closeRun(db, "run-terminal-cancel", "rpc")).toBe(true);
    await plugin(bb);
    const rpc = await harness.behavior.callRpc("cancel_attempt", { attemptId:"attempt-terminal-cancel" }) as { ok:boolean; state:string; reason:string };
    expect(rpc).toMatchObject({ ok:false, state:"accepted" });
    expect(rpc.reason).toContain("closed run");
    const cli = await harness.behavior.runCli(["cancel", "attempt-terminal-cancel"]);
    expect(cli.exitCode).toBe(1);
    expect(stopCalls).toBe(0);
    expect(getAttempt(db, "attempt-terminal-cancel")?.state).toBe("accepted");
    expect(getRun(db, "run-terminal-cancel")?.state).toBe("closed");
    const screen = await harness.behavior.callRpc("get_screen", { projectId }) as { writerResultJson:string|null };
    expect(JSON.parse(screen.writerResultJson!)).toEqual(receipt);
    await harness.lifecycle.dispose();
  });

  it("still stops an active attempt through cancel_attempt after observing idle", async () => {
    const order:string[] = [];
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{
      stop:async () => { order.push("stop"); return { ok:true }; },
      get:async () => { order.push("get"); return { id:"writer-active", status:"idle" }; },
      listRunning:async () => { order.push("listRunning"); return []; },
    } } });
    const db = openDatabase(bb);
    saveLegacyWriterConfig(db);
    createRun(db, "run-active-cancel", projectId);
    createAttempt(db, { id:"attempt-active-cancel", runId:"run-active-cancel", taskId:"t" });
    transitionAttempt(db, "attempt-active-cancel", "spawn_requested");
    transitionAttempt(db, "attempt-active-cancel", "running", { threadId:"writer-active" });
    await plugin(bb);
    expect(await harness.behavior.callRpc("cancel_attempt", { attemptId:"attempt-active-cancel" }))
      .toMatchObject({ ok:true, state:"canceled" });
    expect(order).toEqual(["stop", "get", "listRunning"]);
    expect(getAttempt(db, "attempt-active-cancel")?.state).toBe("canceled");
    await harness.lifecycle.dispose();
  });

  it("cancels a queued attempt through CLI without requiring or stopping a provider thread", async () => {
    let stopCalls=0;
    const {bb,harness}=createFakePluginHost({pluginId:"lane-pilot",sdk:{threads:{stop:async()=>{stopCalls++;return {ok:true};}}}});
    const db=openDatabase(bb);
    saveLegacyWriterConfig(db);
    await plugin(bb);
    createRun(db,"run-queued-cancel",projectId);
    createAttempt(db,{id:"attempt-queued-cancel",runId:"run-queued-cancel",taskId:"queued-task"});
    const result=await harness.behavior.runCli(["cancel","attempt-queued-cancel"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ok:true,state:"canceled",attemptId:"attempt-queued-cancel",reason:null});
    expect(getAttempt(db,"attempt-queued-cancel")?.state).toBe("canceled");
    expect(stopCalls).toBe(0);
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
    saveLegacyWriterConfig(db);
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
