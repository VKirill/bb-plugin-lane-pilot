import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/contracts";
import { countChargedAttempts, createAttempt, createRun, createTask, getAttempt, openDatabase, transitionAttempt } from "../src/database";
import { createWriterFinish } from "../src/server/writer/finish";
import { failureClass, isWriterSilent } from "../src/failure-class";
import { countRunNudges, loadWriterNudge, sweepWriterSilence, type SilenceDeps } from "../src/server/writer-silence";

const MIN = 60_000;
const T0 = 1_800_000_000_000;

type Attempt = ReturnType<SilenceDeps["openAttempts"]>[number];

function setup(options:{ status?:string; lastEventAt?:number | null; minutes?:number; attempts?:Attempt[] } = {}) {
  const store = new Map<string, unknown>();
  const sent:Array<Record<string, unknown>> = [];
  const logs:string[] = [];
  const listed:Array<Record<string, unknown>> = [];
  let disposed = false;
  let eventAt = options.lastEventAt === undefined ? T0 : options.lastEventAt;
  let status = options.status ?? "active";
  const bb = { sdk:{ threads:{
    send:async (args:Record<string, unknown>) => { sent.push(args); return {}; },
    events:{ list:async (args:Record<string, unknown>) => { listed.push(args); return eventAt === null ? [] : [{ type:"item/started", seq:9, createdAt:eventAt }]; } },
  } }, storage:{ kv:{ get:async (key:string) => store.get(key) ?? null, set:async (key:string, value:unknown) => { store.set(key, value); } } } };
  const attempts:Attempt[] = options.attempts ?? [{ id:"a1", run_id:"run", task_id:"T1", thread_id:"thr_w", state:"running", project_id:"proj" }];
  const deps:SilenceDeps = {
    bb:bb as never, openAttempts:() => attempts, getThread:async () => ({ status }),
    silenceMinutes:() => options.minutes ?? 20, isDisposed:() => disposed, log:(line) => logs.push(line),
  };
  return { deps, store, sent, logs, listed, kv:bb.storage.kv,
    setDisposed:(value:boolean) => { disposed = value; }, setStatus:(value:string) => { status = value; }, setEventAt:(value:number | null) => { eventAt = value; } };
}

describe("writer silence sweep", () => {
  it("leaves a writer alone while its last event is younger than the limit", async () => {
    const { deps, sent } = setup();
    expect(await sweepWriterSilence(deps, T0 + 19 * MIN)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("steers a silent active writer once, records it and reads only that thread's events", async () => {
    const { deps, sent, logs, store, listed } = setup();
    expect(await sweepWriterSilence(deps, T0 + 25 * MIN)).toEqual([{ attemptId:"a1", action:"nudged", count:1 }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId:"thr_w", mode:"steer-if-active" });
    expect(JSON.stringify(sent[0]!.input)).toContain("no activity for 25 min. Continue; if a command hangs, stop it and go on; finish with your summary.");
    expect(store.get("writer-nudge:a1")).toEqual({ count:1, at:T0 + 25 * MIN });
    expect(logs).toHaveLength(1);
    expect(listed).toEqual([{ threadId:"thr_w", order:"desc", limit:"50" }]);
  });

  it("waits a full limit after a nudge before the next step, then ends the attempt after two nudges", async () => {
    const { deps, sent, logs, kv } = setup();
    await sweepWriterSilence(deps, T0 + 25 * MIN);
    // The nudge is not in the thread's events (a hung turn takes none): the writer is silent since the nudge.
    expect(await sweepWriterSilence(deps, T0 + 40 * MIN)).toEqual([]);
    expect(await sweepWriterSilence(deps, T0 + 46 * MIN)).toEqual([{ attemptId:"a1", action:"nudged", count:2 }]);
    expect(await sweepWriterSilence(deps, T0 + 60 * MIN)).toEqual([]);
    expect(await sweepWriterSilence(deps, T0 + 67 * MIN)).toEqual([{ attemptId:"a1", action:"ended", count:2 }]);
    expect(sent).toHaveLength(2);
    expect(await loadWriterNudge(kv, "a1")).toMatchObject({ count:2, ended:true });
    expect(logs).toHaveLength(3);
    // An ended attempt is never nudged again.
    expect(await sweepWriterSilence(deps, T0 + 200 * MIN)).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it("does not nudge a writer that answered the nudge with new events", async () => {
    const { deps, sent, setEventAt } = setup();
    await sweepWriterSilence(deps, T0 + 25 * MIN);
    setEventAt(T0 + 30 * MIN);
    expect(await sweepWriterSilence(deps, T0 + 49 * MIN)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("follows writer.silence_nudge_min", async () => {
    const { deps, sent } = setup({ minutes:5 });
    expect(await sweepWriterSilence(deps, T0 + 6 * MIN)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("skips idle threads, attempts that are not running, and threads with no events", async () => {
    const idle = setup({ status:"idle" });
    expect(await sweepWriterSilence(idle.deps, T0 + 90 * MIN)).toEqual([]);
    const queued = setup({ attempts:[{ id:"a2", run_id:"run", task_id:"T1", thread_id:"thr_w", state:"queued", project_id:"proj" }] });
    expect(await sweepWriterSilence(queued.deps, T0 + 90 * MIN)).toEqual([]);
    const noThread = setup({ attempts:[{ id:"a3", run_id:"run", task_id:"T1", thread_id:null, state:"running", project_id:"proj" }] });
    expect(await sweepWriterSilence(noThread.deps, T0 + 90 * MIN)).toEqual([]);
    const empty = setup({ lastEventAt:null });
    expect(await sweepWriterSilence(empty.deps, T0 + 90 * MIN)).toEqual([]);
    expect([idle.sent, queued.sent, noThread.sent, empty.sent].flat()).toEqual([]);
  });

  it("stops when the plugin is disposed and survives a failed send without recording a nudge", async () => {
    const stopped = setup();
    stopped.setDisposed(true);
    expect(await sweepWriterSilence(stopped.deps, T0 + 90 * MIN)).toEqual([]);
    expect(stopped.sent).toEqual([]);

    const failing = setup();
    (failing.deps.bb.sdk.threads as { send:unknown }).send = async () => { throw new Error("thread is gone"); };
    expect(await sweepWriterSilence(failing.deps, T0 + 90 * MIN)).toEqual([]);
    expect(await loadWriterNudge(failing.kv, "a1")).toBeNull();
    expect(failing.logs[0]).toContain("thread is gone");
  });

  it("counts the nudges of a run for the wait receipt", async () => {
    const { kv, deps } = setup();
    await sweepWriterSilence(deps, T0 + 25 * MIN);
    await kv.set("writer-nudge:a2", { count:2, at:T0 } as never);
    expect(await countRunNudges(kv, ["a1", "a2", "a3"])).toBe(3);
  });
});

describe("writer_silent_after_nudge", () => {
  it("is a provider failure that spends no attempt", () => {
    const reason = "writer_silent_after_nudge: no activity after 2 nudges";
    expect(isWriterSilent(reason)).toBe(true);
    expect(failureClass("provider_error", reason)).toBe("provider");
    expect(failureClass("blocked", reason)).toBe("provider");
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run','bb','{}',1)").run();
    createAttempt(db, { id:"a1", runId:"run", taskId:"T1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId:"thr_a1" });
    transitionAttempt(db, "a1", "provider_error", { reason });
    expect(countChargedAttempts(db, "run", "T1")).toBe(0);
  });
});

describe("the writer's watcher", () => {
  const config: PrototypeConfig = {
    projectId:"P", hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo",
    pmProviderId:"codex", pmModel:"codex-test", writerProviderId:"codex", writerModel:"codex-test",
  };
  const task: TaskV2 = {
    schema_version:2, id:"t1", title:"Write", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[],
    out_of_scope:[], expected_outputs:["note.txt"], owns_paths:["note.txt"], never_touch:[], depends_on:[],
    objective:"write", acceptance:["file exists"], verify:"none", verification:[],
  };

  it("ends the attempt as writer_silent_after_nudge once the sweep marked it, and stops the thread", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    createTask(db, { id:"t1", runId:"run", kind:"bb", contract:task });
    createAttempt(db, { id:"a1", runId:"run", taskId:"t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId:"writer-1" });
    await bb.storage.kv.set("writer-nudge:a1", { count:2, at:T0, ended:true } as never);
    const stopped:string[] = [];
    const ctx = {
      state:{ disposed:false },
      bb:{ storage:bb.storage, log:{ warn() {}, error() {} },
        sdk:{ threads:{ stop:async ({ threadId }:{ threadId:string }) => { stopped.push(threadId); }, events:{ list:async () => [] }, get:async () => ({ status:"active" }) } } },
      db, getThreadBounded:async () => ({ status:"active" }), host:{ call:async () => ({}) },
    };
    const finish = createWriterFinish(ctx as never, { validateWriterResult:async () => ({ status:"accepted" }),
      runBudgetFor:() => ({ snapshot:() => ({ limits:{} }) }) } as never);
    const result = await finish.finishWriterAttempt({ projectId:"P", config, task, runId:"run", taskId:"t1", attemptId:"a1", pmThreadId:"pm", writerThreadId:"writer-1", dirtBefore:[] });
    expect(result).toMatchObject({ status:"provider_error", reason:"writer_silent_after_nudge: no activity after 2 nudges" });
    expect(stopped).toEqual(["writer-1"]);
    expect(getAttempt(db, "a1")).toMatchObject({ state:"provider_error" });
    expect(countChargedAttempts(db, "run", "t1")).toBe(0);
  });
});
