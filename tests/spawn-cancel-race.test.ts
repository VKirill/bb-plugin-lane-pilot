import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, savePrototypeConfig, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { createWriterSpawn } from "../src/rooms/writer/server/spawn";

const config: PrototypeConfig = {
  projectId:"P", hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo",
  pmProviderId:"codex", pmModel:"codex-test", writerProviderId:"codex", writerModel:"codex-test",
};
const task: TaskV2 = {
  schema_version:2, id:"t1", title:"Write", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:["note.txt"], owns_paths:["note.txt"], never_touch:[], depends_on:[],
  objective:"write", acceptance:["file exists"], verify:"none", verification:[],
};

/** The PM's stop lands while the writer starts: the attempt is `cancel_requested` before the spawn finds out. */
function world(options:{ onBreaker?:boolean; providers?:unknown[]; spawn?:() => Promise<unknown> }) {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", "/repo");
  createTask(db, { id:"t1", runId:"run", kind:"bb", contract:task });
  createAttempt(db, { id:"a1", runId:"run", taskId:"t1" });
  const stop = () => transitionAttempt(db, "a1", "cancel_requested", { reason:"stop" });
  const ctx = {
    bb:{ storage:bb.storage, log:{ info() {}, warn() {} },
      sdk:{ projects:{ get:async () => ({ sources:[] }) },
        providers:{ list:async () => options.providers ?? [{ id:"codex", available:true, serviceTiers:[{ id:"default" }] }],
          models:async () => ({ models:[{ id:"codex-test", model:"codex-test", supportedReasoningEfforts:[{ reasoningEffort:"medium" }] }] }) },
        files:{ read:async () => ({ content:null }) },
        threads:{ get:async () => ({ id:"pm", projectId:"P", status:"idle" }), stop:async () => ({}), spawn:options.spawn ?? (async () => ({ id:"writer-1" })) } } },
    db,
    host:{ call:async (method:string) => {
      if (method === "runCommand") return { hostId:"h", exitCode:0, stdout:"[]", stderr:"" };
      if (method === "gitCreateWorktree") return { status:"ready", path:"/wt/a1/repo", branch:"lane/a1", reason:null };
      return {};
    } },
    effectiveProjectSettings:async () => { if (!options.onBreaker) stop(); return { values:{ "jev.LANE_JEV_EFFORT":false, "memory.enabled":false, "adoc.040":"auto" } }; },
  };
  const services = { providerBreaker:{ decide:() => { if (options.onBreaker) stop(); return options.onBreaker ? { allow:false, reason:"open" } : { allow:true }; } }, ruleScan:{ chainForRun:async () => [] } };
  const writer = createWriterSpawn(ctx as never, services as never);
  const run = () => writer.spawnWriterAttempt({ projectId:"P", runId:"run", taskId:"t1", attemptId:"a1", config, task, plan:"write", pmThreadId:"pm" });
  const refused = () => db.prepare("SELECT from_state, to_state FROM lane_pilot_attempt_transition WHERE attempt_id='a1' AND refused=1").all();
  return { db, run, refused };
}

describe("a stop requested while the writer starts", () => {
  it("ends canceled when the provider breaker refuses meanwhile, not as a refused cancel_requested -> spawn_rejected move", async () => {
    const w = world({ onBreaker:true });
    await expect(w.run()).resolves.toMatchObject({ ok:false, status:"canceled", attemptId:"a1" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
    expect(w.refused()).toEqual([]);
  });

  it("ends canceled when the writer selection fails meanwhile (provider gone)", async () => {
    const w = world({ providers:[] });
    await expect(w.run()).resolves.toMatchObject({ ok:false, status:"canceled", attemptId:"a1" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
    expect(w.refused()).toEqual([]);
  });

  it("ends canceled when the spawn itself throws after the stop was requested", async () => {
    const w = world({ spawn:async () => { throw new Error("boom"); } });
    await expect(w.run()).resolves.toMatchObject({ ok:false, status:"canceled", attemptId:"a1" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
    expect(w.refused()).toEqual([]);
  });
});

describe("a stop requested while the writer's thread is looked up again", () => {
  it("ends canceled when the reconcile finds no thread", async () => {
    const triple = { lanePilotRunId:"run-rc", lanePilotTaskId:"task-rc", attemptId:"attempt-rc" };
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{ list:async () => [] as never } } });
    const db = openDatabase(bb);
    savePrototypeConfig(db, { ...config, projectId:"project-test" });
    createRun(db, triple.lanePilotRunId, "project-test");
    setRunThread(db, triple.lanePilotRunId, "pm-thread");
    createAttempt(db, { id:triple.attemptId, runId:triple.lanePilotRunId, taskId:triple.lanePilotTaskId });
    transitionAttempt(db, triple.attemptId, "spawn_requested");
    transitionAttempt(db, triple.attemptId, "cancel_requested", { reason:"canceled while its writer was starting" });
    await plugin(bb);
    await harness.behavior.runCli(["recover", triple.attemptId]);
    expect(getAttempt(db, triple.attemptId)).toMatchObject({ state:"canceled" });
    expect(db.prepare("SELECT 1 FROM lane_pilot_attempt_transition WHERE attempt_id=? AND refused=1").all(triple.attemptId)).toEqual([]);
    await harness.lifecycle.dispose();
  });
});
