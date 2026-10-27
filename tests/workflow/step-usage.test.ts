import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { graphStepMetadata } from "../../src/rooms/core/server";
import { withUsage } from "../../src/rooms/usage/server";
import { lpTaskPipelineExecutor } from "../../src/rooms/writer/server/dispatch-workflow";
import { pipelineWriterTag } from "../../src/rooms/writer/server/pipeline-tag";
import { createAttempt, createRun, openDatabase } from "../../src/rooms/storage/database";

const spent = (total: number) => [{ type: "turn/started", seq: 1 }, { type: "thread/tokenUsage/updated", seq: 2, createdAt: 2, data: { turnId: "t1", tokenUsage: { last: { inputTokens: total, outputTokens: 0, totalTokens: total }, total: { inputTokens: total, outputTokens: 0, totalTokens: total } } } }];

/** A host whose threads report the given token totals (a thread not listed has events but no usage, like an ACP provider). */
function hostWith(totals: Record<string, number>) {
  return createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: { events: { list: async ({ threadId }: { threadId: string }) => (totals[threadId] === undefined ? [{ type: "turn/started", seq: 1 }] : spent(totals[threadId]!).map((event) => ({ ...event, threadId }))) } } } as never,
  });
}

describe("withUsage", () => {
  it("sums what the named threads spent and names the first", async () => {
    const { bb } = hostWith({ a: 1000, b: 500 });
    const got = await withUsage(bb, ["a", "b", "a", null, undefined]);
    expect(got.threadId).toBe("a");
    expect(got.usage).toMatchObject({ tokens: 1500 });
    expect(got.usage).not.toHaveProperty("unknown");
  });

  it("marks the usage unknown when a thread reports none, never as free", async () => {
    const { bb } = hostWith({ a: 1000 });
    const got = await withUsage(bb, ["a", "c"]);
    expect(got.usage).toMatchObject({ tokens: 1000, unknown: true });
  });

  it("gives nothing for a stage that spawned no thread", async () => {
    const { bb } = hostWith({});
    expect(await withUsage(bb, null)).toEqual({});
    expect(await withUsage(bb, [])).toEqual({});
  });
});

describe("graphStepMetadata", () => {
  it("is the metadata an agent node writes, and nothing without a run", () => {
    expect(graphStepMetadata({ runId: "wfr_1", stepKey: "s1", nodeId: "pm-read" })).toEqual({ lanePilotWorkflowRunId: "wfr_1", lanePilotWorkflowStep: "s1", lanePilotWorkflowNode: "pm-read" });
    expect(graphStepMetadata(undefined)).toEqual({});
    expect(graphStepMetadata({ runId: "" })).toEqual({});
  });
});

describe("the writer step of the task pipeline", () => {
  function setup() {
    const { bb } = hostWith({ w1: 3000, w2: 2000 });
    const db = openDatabase(bb);
    createRun(db, "run-1", "proj-1", "bb");
    createAttempt(db, { id: "att-1", runId: "run-1", taskId: "task-1" });
    createAttempt(db, { id: "att-2", runId: "run-1", taskId: "task-1" });
    return { bb, db };
  }
  const poll = (bb: never, db: never) => lpTaskPipelineExecutor({ journal: { db } } as never).poll!(
    { runId: "wfr", stepKey: "s", nodeId: "writer", await: { kind: "attempt", detail: { runId: "run-1", taskId: "task-1" } } }, { runtime: { ctx: { bb } } as never, node: {} as never });

  it("reports the spend of every writer attempt of the task when the task ends", async () => {
    const { bb, db } = setup();
    db.prepare("UPDATE lane_pilot_attempt SET state='blocked', thread_id='w1' WHERE id='att-1'").run();
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', thread_id='w2' WHERE id='att-2'").run();
    const result = await poll(bb as never, db as never) as { output: { reply: { state: string } }; usage?: { tokens: number }; threadId?: string };
    expect(result.output.reply.state).toBe("accepted");
    expect(result.usage).toMatchObject({ tokens: 5000 });
    expect(result.threadId).toBe("w1");
  });

  it("keeps waiting while the latest attempt runs", async () => {
    const { bb, db } = setup();
    expect(await poll(bb as never, db as never)).toBeNull();
  });
});

describe("pipelineWriterTag", () => {
  it("names the writer step of the task's pipeline run, and nothing when there is none", () => {
    const { bb } = hostWith({});
    const db = openDatabase(bb);
    expect(pipelineWriterTag(db, "run-1", "task-1")).toEqual({});
    const now = Date.now();
    const run = db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,link_run_id,link_task_id,status,created_at,updated_at) VALUES (?,?,1,'x','{}','run-1','task-1','running',?,?)");
    run.run("wfr_old", "lp-task-pipeline", now - 10, now - 10);
    run.run("wfr_new", "lp-task-pipeline", now, now);
    run.run("wfr_x", "other", now + 5, now + 5);
    const step = db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,updated_at) VALUES (?,?,?,?,1,'running',?)");
    step.run("wfr_new", "pm-read:1", "o1", "pm-read", now);
    step.run("wfr_new", "writer:1", "o2", "writer", now);
    expect(pipelineWriterTag(db, "run-1", "task-1")).toEqual({ lanePilotWorkflowRunId: "wfr_new", lanePilotWorkflowStep: "writer:1", lanePilotWorkflowNode: "writer" });
  });
});
