import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, listStageReceipts, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/database";
import type { TaskV2 } from "../../src/contracts";

const projectId = "stage-project";
const pmThreadId = "stage-pm";
const config = {
  projectId, hostId:"stage-host", pmWorkspacePath:"/tmp/stage-pm", writerWorkspacePath:"/tmp/stage-writer",
  pmProviderId:"codex", pmModel:"gpt-6-luna", writerProviderId:"codex", writerModel:"gpt-6-luna",
};
const task:TaskV2 = {
  schema_version:2, id:"stage-task", title:"Write a fixture", risk:"low", lane:"writer",
  project_cwd:config.writerWorkspacePath, read_first:["README.md L1-L2"], interfaces:["note.txt exists"],
  invariants:["Only write note.txt"], out_of_scope:["Plugin source"], expected_outputs:["note.txt"],
  owns_paths:["note.txt"], never_touch:[".git/**"], depends_on:[], objective:"Write note.txt",
  acceptance:["note.txt is present"], verify:"tests",
  verification:[{ command:"test -f note.txt", cwd:config.writerWorkspacePath, timeout_sec:30 }],
};

async function setup(critiqueOutput:string) {
  const spawned:Array<Record<string,unknown>> = [];
  let snapshots = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId:"lane-pilot",
    sdk:{
      threads:{
        getPluginMetadata:async ({ threadId }) => threadId === pmThreadId
          ? { role:"pm", lanePilotRunId:"stage-run" } : { role:"writer" },
        spawn:async (args) => {
          const request = args as unknown as Record<string,unknown>;
          spawned.push(request);
          return { id:((request.pluginMetadata as Record<string,unknown>).stageId === "plan-critique") ? "critic-thread" : "writer-thread" };
        },
        wait:async () => ({ matched:true, thread:{ status:"idle" } }),
        get:async ({ threadId }) => ({ id:threadId, status:"idle" }),
        output:async ({ threadId }) => threadId === "critic-thread"
          ? { output:critiqueOutput } : { output:"writer created note.txt" },
        list:async () => [] as never,
      },
      providers:{
        list:async () => ["codex", "critic"].map((id) => ({ id, available:true, capabilities:{ supportsServiceTier:true }, serviceTiers:[{ id:"default", label:"Default" }] })) as never,
        models:async (args) => { const providerId = (args as { providerId:string } | undefined)?.providerId; return { models:[{ id:providerId === "critic" ? "critic-model" : "gpt-6-luna", model:providerId === "critic" ? "critic-model" : "gpt-6-luna",
          supportedReasoningEfforts:["medium","high"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })) }] as never }; },
      },
      files:{
        read:async ({ path }) => path.endsWith("note.txt") ? { content:"reviewed output\n" } : { content:null },
        write:async () => ({ ok:true }),
      },
    },
    experimental_callHostRpc:(call) => {
      if (call.method !== "runCommand") throw new Error(`unexpected host method ${call.method}`);
      const command = String((call.input as { command?:string }).command ?? "");
      if (command.includes("porcelain")) {
        snapshots += 1;
        return { hostId:config.hostId, exitCode:0,
          stdout:JSON.stringify(snapshots === 1 ? [] : [{ path:"note.txt", sha256:"new-content" }]), stderr:"" };
      }
      return { hostId:config.hostId, exitCode:0, stdout:"", stderr:"" };
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
  createRun(db, "stage-run", projectId, "bb", config.writerWorkspacePath);
  setRunThread(db, "stage-run", pmThreadId);
  await plugin(bb);
  return { bb, db, harness, spawned };
}

describe("stage → native writer → receipt", () => {
  it("runs a real native critic before the writer and returns persisted stage receipts", async () => {
    const { db, harness, spawned } = await setup('{"decision":"approve","summary":"Plan is scoped and verifiable","findings":[]}');
    const dispatch = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
      { confirm:true, plan:"Create the fixture and check its contents", task }, { threadId:pmThreadId, projectId })));
    expect(dispatch.state).toBe("queued");
    const result = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_wait_writer",
      { runId:"stage-run", timeoutSec:3 }, { threadId:pmThreadId, projectId })));
    expect(result.state).toBe("accepted");
    expect(spawned.map((row) => (row.pluginMetadata as Record<string,unknown>).stageId ?? (row.pluginMetadata as Record<string,unknown>).role))
      .toEqual(["plan-critique", "writer"]);
    expect(spawned[1].prompt).toContain('"startLine": 1');
    expect(spawned[1].prompt).toContain('"endLine": 2');
    expect(listStageReceipts(db, "stage-run", task.id).map((row) => [row.stageId,row.state]))
      .toEqual([["acceptance-receipt","passed"],["plan-critique","passed"],["verification","passed"],["writer-agent","passed"]]);
    const receipts = listStageReceipts(db, "stage-run", task.id);
    expect(receipts.find((row) => row.stageId === "verification")?.result).toEqual({
      produced:["note.txt"], verification:[{ command:"test -f note.txt", exitCode:0, stderr:"" }],
    });
    expect((receipts.find((row) => row.stageId === "acceptance-receipt")?.result as { acceptancePath?:string })?.acceptancePath)
      .toContain("acceptance.json");
    expect((receipts.find((row) => row.stageId === "acceptance-receipt")?.result as { readFirst?:unknown[] })?.readFirst)
      .toEqual([{ path:"README.md", windows:[{ startLine:1, endLine:2 }] }]);
    expect(result.stages).toHaveLength(4);
    await harness.lifecycle.dispose();
  });

  it("uses the configured critique provider and model", async () => {
    const { bb, db, harness, spawned } = await setup('{"decision":"approve","summary":"Checked","findings":[]}');
    saveProjectSetting(db, projectId, "plan_critique.provider", "critic");
    saveProjectSetting(db, projectId, "plan_critique.model", "critic-model");
    await harness.behavior.callAgentTool("lane_pilot_dispatch_writer", { confirm:true, plan:"Write the fixture", task }, { threadId:pmThreadId, projectId });
    await harness.behavior.callAgentTool("lane_pilot_wait_writer", { runId:"stage-run", timeoutSec:3 }, { threadId:pmThreadId, projectId });
    expect(spawned[0]).toMatchObject({ providerId:"critic", model:"critic-model" });
    expect(spawned[1]).toMatchObject({ providerId:"codex", model:"gpt-6-luna" });
    await harness.lifecycle.dispose();
  });

  it("fails closed on malformed critique output and never spawns a writer", async () => {
    const { db, harness, spawned } = await setup("not JSON");
    const result = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
      { confirm:true, plan:"Create the fixture", task }, { threadId:pmThreadId, projectId })));
    expect(result.state).toBe("blocked");
    expect(spawned).toHaveLength(1);
    expect((spawned[0].pluginMetadata as Record<string,unknown>).stageId).toBe("plan-critique");
    expect(listStageReceipts(db, "stage-run", task.id).map((row) => [row.stageId,row.state]))
      .toEqual([["acceptance-receipt","skipped"],["plan-critique","failed"],["verification","skipped"],["writer-agent","skipped"]]);
    await harness.lifecycle.dispose();
  });

  it("records blocked and skipped receipts when task preflight rejects unsafe read_first", async () => {
    const { db, harness, spawned } = await setup('{"decision":"approve","summary":"Checked","findings":[]}');
    const unsafeTask = { ...task, read_first:["../outside.md L1-L2"] };
    const result = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
      { confirm:true, plan:"Create the fixture", task:unsafeTask }, { threadId:pmThreadId, projectId })));
    expect(result.state).toBe("blocked");
    expect(result.reason).toContain("project-relative");
    expect(spawned).toHaveLength(0);
    expect(listStageReceipts(db, "stage-run", task.id).map((row) => [row.stageId,row.state]))
      .toEqual([["acceptance-receipt","skipped"],["plan-critique","blocked"],["verification","skipped"],["writer-agent","skipped"]]);
    await harness.lifecycle.dispose();
  });
});
