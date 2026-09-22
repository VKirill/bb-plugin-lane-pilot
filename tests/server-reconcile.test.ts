import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import {
  createAttempt,
  createRun,
  getAttempt,
  openDatabase,
  savePrototypeConfig,
  setRunThread,
  transitionAttempt,
} from "../src/database";

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

describe("production spawn_unknown reconciliation", () => {
  it("reconciles by metadata after the spawn response is lost and continues with the found thread", async () => {
    let capturedMetadata: Record<string,unknown> | undefined;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-live" }
            : capturedMetadata ?? {},
          spawn: async (args) => {
            capturedMetadata = args.pluginMetadata as Record<string,unknown>;
            throw Object.assign(new Error("synthetic response timeout"), { code:"ETIMEDOUT" });
          },
          list: async () => [{ id:"writer-existing" }] as never,
          wait: async () => { throw new Error("wait sentinel after reconcile"); },
          get: async () => ({ id:"writer-existing", status:"active" }) as never,
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
    createRun(db, "run-live", projectId);
    setRunThread(db, "run-live", pmThreadId);
    await plugin(bb);

    await expect(harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true },
      { threadId:pmThreadId, projectId },
    )).rejects.toThrow("wait sentinel after reconcile");

    const row = db.prepare("SELECT thread_id,state FROM lane_pilot_attempt WHERE run_id='run-live'").get() as
      {thread_id:string|null; state:string};
    expect(row).toEqual({ thread_id:"writer-existing", state:"running" });
    expect(capturedMetadata).toMatchObject({
      role:"writer",
      lanePilotRunId:"run-live",
      lanePilotTaskId:expect.any(String),
      attemptId:expect.any(String),
    });
    await harness.lifecycle.dispose();
  });

  it("recovery without thread_id searches the complete list by the persisted triple", async () => {
    const triple = { lanePilotRunId:"run-recover", lanePilotTaskId:"task-recover", attemptId:"attempt-recover" };
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          list: async () => [{ id:"writer-found" }] as never,
          getPluginMetadata: async () => triple,
          get: async () => ({ id:"writer-found", status:"active" }) as never,
        },
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, triple.lanePilotRunId, projectId);
    setRunThread(db, triple.lanePilotRunId, pmThreadId);
    createAttempt(db, { id:triple.attemptId, runId:triple.lanePilotRunId, taskId:triple.lanePilotTaskId });
    transitionAttempt(db, triple.attemptId, "spawn_unknown", { reason:"response lost" });
    expect(getAttempt(db, triple.attemptId)?.thread_id).toBeNull();
    await plugin(bb);

    const result = await harness.behavior.runCli(["recover", triple.attemptId]);
    expect(result).toMatchObject({ exitCode:1, stderr:"writer is not idle: active" });
    expect(getAttempt(db, triple.attemptId)).toMatchObject({ thread_id:"writer-found", state:"running" });
    await harness.lifecycle.dispose();
  });
});
