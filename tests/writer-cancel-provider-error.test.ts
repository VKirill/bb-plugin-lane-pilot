import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, saveProjectSetting, saveStageReceipt, transitionAttempt } from "../src/rooms/storage/database";
import { createWriterFinish } from "../src/rooms/writer/server/finish";

const config: PrototypeConfig = {
  projectId:"P", hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo",
  pmProviderId:"codex", pmModel:"codex-test", writerProviderId:"codex", writerModel:"codex-test",
};
const task: TaskV2 = {
  schema_version:2, id:"t1", title:"Write", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:["note.txt"], owns_paths:["note.txt"], never_touch:[], depends_on:[],
  objective:"write", acceptance:["file exists"], verify:"none", verification:[],
};

/** A running attempt whose stop was requested (`cancel_requested`), the way the PM's cancel leaves it before the loop notices. */
function world(options:{ threadStatus:string; output?:string; cancel?:boolean; validate?:(stop:()=>void)=>Promise<Record<string,unknown>>; merge?:(stop:()=>void)=>Record<string,unknown>; ledger?:boolean }) {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", "/repo");
  createTask(db, { id:"t1", runId:"run", kind:"bb", contract:task });
  createAttempt(db, { id:"a1", runId:"run", taskId:"t1" });
  transitionAttempt(db, "a1", "spawn_requested");
  transitionAttempt(db, "a1", "running", { threadId:"writer-1" });
  if (options.cancel !== false) transitionAttempt(db, "a1", "cancel_requested", { threadId:"writer-1" });
  if (options.ledger) {
    // An earlier pass sent the code repair and was lost to a reload: the finish waits for that repair writer and checks its result.
    saveProjectSetting(db, "P", "code_critique.enabled", true);
    saveStageReceipt(db, { runId:"run", taskId:"t1", stageId:"code-critique", contractVersion:1, state:"blocked", inputSha256:"a".repeat(64), outputSha256:null,
      attempt:0, providerId:"critic", model:"critic-model", threadId:null, reason:"critique_changes_requested", updatedAt:Date.now(),
      result:{ revisionSha256:"r1", artifactRevisionSha256:"r1", findingsHash:"", repairRound:1, spawnAttempted:true, repairThreadId:"repair-1",
        policy:{ enabled:true, mode:"gate", autoFix:true, maxRounds:1, agent:"code-critic", providerId:"critic", model:"critic-model" } } });
  }
  const stopped:string[] = [];
  const threads = {
    stop:async ({ threadId }:{ threadId:string }) => { stopped.push(threadId); },
    events:{ list:async ({ threadId }:{ threadId:string }) => threadId === "repair-1" ? [{ type:"turn/started", threadId, seq:1 }, { type:"turn/completed", threadId, seq:2, data:{ status:"completed" } }] : [] }, get:async () => ({ status:options.threadStatus }),
    output:async (_args?:unknown) => ({ text:options.output ?? "" }),
  };
  const stop = () => { if (getAttempt(db, "a1")?.state === "running") transitionAttempt(db, "a1", "cancel_requested", { threadId:"writer-1" }); };
  const ctx = {
    state:{ disposed:false },
    bb:{ storage:bb.storage, log:{ warn() {}, error() {} },
      sdk:{ threads, files:{ read:async () => ({ content:"note" }) } } },
    db, getThreadBounded:async () => ({ status:options.threadStatus }), host:{ call:async (method:string) => method === "gitIntegrate" && options.merge ? options.merge(stop) : ({}) },
    isDisposed:() => false, log:() => undefined,
  };
  const finish = createWriterFinish(ctx as never, { validateWriterResult:async () => options.validate ? options.validate(stop) : ({ status:"accepted" }),
    persistWriterAcceptance:async () => ({ state:"passed" }),
    workspaceDirt:async () => ({ ok:true, snapshots:[] }),
    runBudgetFor:() => ({ snapshot:() => ({ limits:{} }) }) } as never);
  const run = () => finish.finishWriterAttempt({ projectId:"P", config, task, runId:"run", taskId:"t1", attemptId:"a1", pmThreadId:"pm", writerThreadId:"writer-1", dirtBefore:[] });
  const refused = () => db.prepare("SELECT from_state, to_state FROM lane_pilot_attempt_transition WHERE attempt_id='a1' AND refused=1").all();
  return { bb, db, threads, run, stopped, refused };
}

describe("a stop requested while the writer's thread errors", () => {
  it("ends canceled, not as a refused cancel_requested -> provider_error move", async () => {
    const w = world({ threadStatus:"error" });
    const result = await w.run();
    expect(result).toMatchObject({ status:"canceled", attemptId:"a1", writerThreadId:"writer-1" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
    expect(w.refused()).toEqual([]);
  });

  it("ends canceled when the silence sweep had ended the attempt meanwhile", async () => {
    const w = world({ threadStatus:"active" });
    await w.bb.storage.kv.set("writer-nudge:a1", { count:2, at:1, ended:true } as never);
    const result = await w.run();
    expect(result).toMatchObject({ status:"canceled" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
    expect(w.refused()).toEqual([]);
  });

  it("ends canceled when a failed follow-up wait finds the stop requested", async () => {
    const w = world({ threadStatus:"error" });
    await w.bb.storage.kv.set("writer-followup:a1", 1 as never);
    const result = await w.run();
    expect(result).toMatchObject({ status:"canceled" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
    expect(w.refused()).toEqual([]);
  });

  it("ends canceled when the provider's limit notice arrives after the stop was requested", async () => {
    const w = world({ threadStatus:"idle", output:"Usage limit reached. Upgrade your plan.", cancel:false });
    // The stop lands while the writer's output is being read: the loop's own check has passed already.
    const read = w.threads.output;
    w.threads.output = async (args?:unknown) => {
      transitionAttempt(w.db, "a1", "cancel_requested", { threadId:"writer-1" });
      return read(args);
    };
    const result = await w.run();
    expect(result).toMatchObject({ status:"canceled" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
    expect(w.refused()).toEqual([]);
  });

  it("still ends a writer that errored with no stop requested as provider_error", async () => {
    const w = world({ threadStatus:"error", cancel:false });
    const result = await w.run();
    expect(result).toMatchObject({ status:"provider_error", reason:"writer thread status error" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"provider_error" });
  });
});

// Audit 2026-10-08 r2, item 4: the same race for every move the finish makes after the writer's report is read.
describe("a stop requested while the writer's result is checked or merged", () => {
  for (const status of ["validation_failed", "empty_output", "timeout"] as const) {
    it(`ends canceled, not as a refused cancel_requested -> ${status} move`, async () => {
      const w = world({ threadStatus:"idle", cancel:false, validate:async (stop) => { stop(); return { status, reason:`${status} while stopping` }; } });
      const result = await w.run();
      expect(result).toMatchObject({ status:"canceled", attemptId:"a1", writerThreadId:"writer-1" });
      expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
      expect(w.refused()).toEqual([]);
    });

    it(`still ends ${status} when no stop was requested`, async () => {
      const w = world({ threadStatus:"idle", cancel:false, validate:async () => ({ status, reason:`${status} for real` }) });
      const result = await w.run();
      expect(result).toMatchObject({ status, reason:`${status} for real` });
      expect(getAttempt(w.db, "a1")).toMatchObject({ state:status });
    });
  }

  for (const status of ["validation_failed", "empty_output", "timeout"] as const) {
    it(`ends canceled when the stop lands while a repair writer sent earlier is checked (${status})`, async () => {
      let checks = 0;
      const w = world({ threadStatus:"idle", cancel:false, ledger:true, validate:async (stop) => {
        checks += 1;
        if (checks === 1) return { status:"accepted", output:"", produced:["note.txt"], verification:[] };
        stop();
        return { status, reason:`${status} while stopping` };
      } });
      const result = await w.run();
      expect(checks).toBe(2);
      expect(result).toMatchObject({ status:"canceled", attemptId:"a1" });
      expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
      expect(w.refused()).toEqual([]);
    });
  }

  it("ends canceled when the stop lands during the merge and the merge conflicts", async () => {
    const w = world({ threadStatus:"idle", cancel:false, merge:(stop) => { stop(); return { status:"conflict", conflicts:["note.txt"], commit:null }; } });
    w.db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo-worktrees/a1' WHERE id='a1'").run();
    const result = await w.run();
    expect(result).toMatchObject({ status:"canceled", attemptId:"a1" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
    expect(w.refused()).toEqual([]);
  });

  it("still ends validation_failed on a merge conflict when no stop was requested", async () => {
    const w = world({ threadStatus:"idle", cancel:false, merge:() => ({ status:"conflict", conflicts:["note.txt"], commit:null }) });
    w.db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo-worktrees/a1' WHERE id='a1'").run();
    const result = await w.run();
    expect(result).toMatchObject({ status:"validation_failed" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"validation_failed" });
  });
});
