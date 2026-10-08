import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/contracts";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, transitionAttempt } from "../src/database";
import { createWriterFinish } from "../src/server/writer/finish";

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
function world(options:{ threadStatus:string; output?:string; cancel?:boolean }) {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", "/repo");
  createTask(db, { id:"t1", runId:"run", kind:"bb", contract:task });
  createAttempt(db, { id:"a1", runId:"run", taskId:"t1" });
  transitionAttempt(db, "a1", "spawn_requested");
  transitionAttempt(db, "a1", "running", { threadId:"writer-1" });
  if (options.cancel !== false) transitionAttempt(db, "a1", "cancel_requested", { threadId:"writer-1" });
  const stopped:string[] = [];
  const threads = {
    stop:async ({ threadId }:{ threadId:string }) => { stopped.push(threadId); },
    events:{ list:async () => [] }, get:async () => ({ status:options.threadStatus }),
    output:async (_args?:unknown) => ({ text:options.output ?? "" }),
  };
  const ctx = {
    state:{ disposed:false },
    bb:{ storage:bb.storage, log:{ warn() {}, error() {} },
      sdk:{ threads } },
    db, getThreadBounded:async () => ({ status:options.threadStatus }), host:{ call:async () => ({}) },
  };
  const finish = createWriterFinish(ctx as never, { validateWriterResult:async () => ({ status:"accepted" }),
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
