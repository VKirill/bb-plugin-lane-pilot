import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { createAfterAcceptStarter, registerAfterAcceptExecutors, afterAcceptKey } from "../../src/rooms/workflow/server/after-accept";
import { AFTER_ACCEPT, builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { maybeNotifyWorkflowRun } from "../../src/rooms/workflow/server/pm-notice";
import { createAttempt, createRun, listStageReceipts, openDatabase, setRunThread } from "../../src/rooms/storage/database";
import { recordStage } from "../../src/rooms/runs/server";
import { collectEntries } from "../../src/rooms/wall/journal";

const spent = (total: number) => [{ type: "turn/started", seq: 1 }, { type: "thread/tokenUsage/updated", seq: 2, createdAt: 2, data: { turnId: "t1", tokenUsage: { last: { inputTokens: total, outputTokens: 0, totalTokens: total }, total: { inputTokens: total, outputTokens: 0, totalTokens: total } } } }];

type Stage = "memory-maintenance" | "project-life";
type Call = { stage: Stage; args: Record<string, unknown> };

/**
 * The real engine with the real after-acceptance executors; the two stage functions are stubs that write the receipt a real stage writes
 * (the real ones are covered by tests/memory* and tests/project-life*; here the graph around them is under test).
 */
function setup(behaviour: Partial<Record<Stage, (call: Call) => Promise<Record<string, unknown>> | Record<string, unknown>>> = {}, options: { liveFolder?: boolean; extraOpenAttempt?: boolean } = {}) {
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: { events: { list: async ({ threadId }: { threadId: string }) => spent(threadId === "mem-thread" ? 1000 : 300).map((event) => ({ ...event, threadId })) } } } as never,
  });
  const db = openDatabase(bb);
  createRun(db, "run-1", "proj-1", "bb", "/tmp/writer");
  setRunThread(db, "run-1", "pm-1");
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run-1','bb','{}',1)").run();
  if (options.extraOpenAttempt) createAttempt(db, { id: "other", runId: "run-1", taskId: "T2" });
  const calls: Call[] = [];
  const state = { disposed: false };
  const ctx = { bb, db, state, configForRun: async () => ({ hostId: "h1" }) } as never;
  const stage = (name: Stage, thread: string) => async (args: Record<string, unknown>) => {
    calls.push({ stage: name, args });
    if (behaviour[name]) return behaviour[name]!({ stage: name, args });
    recordStage(db, { runId: "run-1", taskId: "T1", stageId: name, state: "passed", input: "x", threadId: thread, result: { stored: 1 } });
    return { runId: "run-1", taskId: "T1", state: "passed" };
  };
  const services = { runMemoryMaintenance: stage("memory-maintenance", "mem-thread"), runProjectLifeMaintenance: stage("project-life", "life-thread"), isLiveFolder: async () => options.liveFolder === true } as never;
  const engine = new WorkflowEngine({ db, harnessVersion: "t", isDisposed: () => state.disposed });
  registerAfterAcceptExecutors(engine, ctx, services);
  const start = createAfterAcceptStarter(engine, ctx);
  const rows = () => db.prepare("SELECT * FROM lane_pilot_wf_run WHERE workflow_id=?").all(AFTER_ACCEPT) as Array<Record<string, unknown>>;
  return { bb, db, engine, start, calls, rows, state };
}

const outputOf = (row: Record<string, unknown>) => JSON.parse(String(row.output_json)) as Record<string, unknown>;

describe("the after-acceptance graph", () => {
  it("is a starter graph of the merge: never offered, valid, with the two stages side by side", () => {
    const workflow = builtinWorkflow(AFTER_ACCEPT)!;
    expect(workflow.startedBy).toBe("merge");
    expect(workflow.nodes.filter((node) => node.type === "agent").map((node) => node.id).sort()).toEqual(["life", "memory"]);
    expect(workflow.edges.filter((edge) => edge.from === "split").map((edge) => edge.to).sort()).toEqual(["life", "memory"]);
  });

  it("runs memory maintenance and project life, links the run to the task and charges what the helper threads spent", async () => {
    const t = setup();
    t.start("proj-1", "run-1", "T1", "pm-1");
    await t.engine.idle();
    const [row] = t.rows();
    expect(row).toMatchObject({ status: "succeeded", idem_key: afterAcceptKey("run-1", "T1"), project_id: "proj-1", link_run_id: "run-1", link_task_id: "T1" });
    expect(outputOf(row!)).toEqual({ memory_state: "passed", life_state: "passed" });
    expect(t.calls.map((call) => call.stage).sort()).toEqual(["memory-maintenance", "project-life"]);
    // The stage functions get the run, the task, the PM thread and the graph step their helper thread is tagged with.
    for (const call of t.calls) {
      expect(call.args).toMatchObject({ runId: "run-1", taskId: "T1", threadId: "pm-1", projectId: "proj-1", workflow: { runId: row!.id } });
      expect((call.args.workflow as { stepKey: string }).stepKey).toBeTruthy();
    }
    expect(listStageReceipts(t.db, "run-1", "T1").map((receipt) => `${receipt.stageId}:${receipt.state}`).sort()).toEqual(["memory-maintenance:passed", "project-life:passed"]);
    expect(row!.tokens_used).toBe(1300);
  });

  it("a stage that throws or fails fails the graph run, never the task: the other stage still runs", async () => {
    const t = setup({ "memory-maintenance": () => { throw new Error("memory_writer_provider_or_model_unavailable"); } });
    t.start("proj-1", "run-1", "T1", "pm-1");
    await t.engine.idle();
    const [row] = t.rows();
    expect(row).toMatchObject({ status: "failed", reason: "step_failed:gather" });
    expect(t.calls.map((call) => call.stage).sort()).toEqual(["memory-maintenance", "project-life"]);
    // Both stages' own outputs stay in their steps.
    expect(t.db.prepare("SELECT node_id, state, output_json FROM lane_pilot_wf_step WHERE node_id IN ('memory','life') ORDER BY node_id").all()).toEqual([
      { node_id: "life", state: "succeeded", output_json: expect.stringContaining('"state":"passed"') },
      { node_id: "memory", state: "succeeded", output_json: expect.stringContaining("memory_writer_provider_or_model_unavailable") },
    ]);
    expect(listStageReceipts(t.db, "run-1", "T1").map((receipt) => `${receipt.stageId}:${receipt.state}`)).toEqual(["project-life:passed"]);
    const failed = setup({ "project-life": () => ({ state: "failed", reason: "project_life_out_of_scope_write" }) });
    failed.start("proj-1", "run-1", "T1", "pm-1");
    await failed.engine.idle();
    expect(failed.rows()[0]).toMatchObject({ status: "failed" });
    expect(failed.engine.get(String(failed.rows()[0]!.id))?.error).toBe("after_accept_failed: project-life failed (project_life_out_of_scope_write)");
    // The accepted task's own rows are not touched by the graph.
    expect(failed.db.prepare("SELECT count(*) AS n FROM lane_pilot_task WHERE id='T1'").get()).toEqual({ n: 1 });
  });

  it("a stage still running after the last round fails the run: nothing proves the work was done", async () => {
    const t = setup({ "memory-maintenance": () => ({ state: "running", reason: "observing" }) });
    t.start("proj-1", "run-1", "T1", "pm-1");
    await t.engine.idle();
    expect(t.rows()[0]).toMatchObject({ status: "failed" });
    expect(t.engine.get(String(t.rows()[0]!.id))?.error).toBe("after_accept_failed: memory-maintenance did not finish (observing)");
  });

  it("the wall sees exactly one failure when an accepted task's maintenance failed, and the task stays accepted", async () => {
    const t = setup({ "project-life": () => ({ state: "failed", reason: "project_life_out_of_scope_write" }) });
    createAttempt(t.db, { id: "att-1", runId: "run-1", taskId: "T1" });
    t.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att-1'").run();
    t.start("proj-1", "run-1", "T1", "pm-1");
    await t.engine.idle();
    const entries = collectEntries(t.db, { since: 0, until: Date.now() + 60_000, isReal: () => true });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ n: 1, failureClass: "workflow", sources: expect.objectContaining({ wf: 1, attempt: 0 }) });
    expect(t.db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='att-1'").get()).toEqual({ state: "accepted" });
  });

  it("watches a stage that is still running until its receipt is final", async () => {
    let rounds = 0;
    const t = setup({ "memory-maintenance": () => (++rounds < 3 ? { state: "running", reason: "observing" } : { state: "passed" }) });
    t.start("proj-1", "run-1", "T1", "pm-1");
    await t.engine.idle();
    expect(rounds).toBe(3);
    expect(outputOf(t.rows()[0]!).memory_state).toBe("passed");
  });

  it("starts one run per task: a second merge event finds the first", async () => {
    const t = setup();
    t.start("proj-1", "run-1", "T1", "pm-1");
    t.start("proj-1", "run-1", "T1", "pm-1");
    await t.engine.idle();
    t.start("proj-1", "run-1", "T1", "pm-1");
    await t.engine.idle();
    expect(t.rows()).toHaveLength(1);
    expect(t.calls).toHaveLength(2);
  });

  it("skips project life while another task of the run is still open, and in a folder without git", async () => {
    const busy = setup({}, { extraOpenAttempt: true });
    busy.start("proj-1", "run-1", "T1", "pm-1");
    await busy.engine.idle();
    expect(outputOf(busy.rows()[0]!)).toEqual({ memory_state: "passed", life_state: "skipped" });
    expect(busy.calls.map((call) => call.stage)).toEqual(["memory-maintenance"]);
    const live = setup({}, { liveFolder: true });
    live.start("proj-1", "run-1", "T1", "pm-1");
    await live.engine.idle();
    expect(outputOf(live.rows()[0]!).life_state).toBe("skipped");
    expect(live.calls.map((call) => call.stage)).toEqual(["memory-maintenance"]);
  });

  it("leaves a step cut off by a reload open, so the next instance runs it again", async () => {
    let t: ReturnType<typeof setup>;
    t = setup({ "memory-maintenance": () => { t.state.disposed = true; return { state: "running", reason: "observing" }; } });
    t.start("proj-1", "run-1", "T1", "pm-1");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The reload ended the instance in the middle of the loop: the step records no outcome and stays running, as after a crash.
    expect(t.rows()[0]).toMatchObject({ status: "running" });
    expect(t.db.prepare("SELECT state FROM lane_pilot_wf_step WHERE node_id='memory'").get()).toEqual({ state: "running" });
  });

  it("never wakes the PM when it ends", async () => {
    const send = async () => { throw new Error("must not be sent"); };
    const run = { id: "wfrun_1", workflow_id: AFTER_ACCEPT, idem_key: afterAcceptKey("run-1", "T1"), parent_run_id: null, status: "failed", reason: "x", link_run_id: "run-1" } as never;
    expect(await maybeNotifyWorkflowRun({ bb: { sdk: { threads: { send } }, storage: { kv: { get: async () => null, set: async () => undefined } } } as never, log: () => undefined, run, pmThreadId: "pm-1", startedBySchedule: false })).toBe(false);
  });

  it("is only logged, never thrown, when the engine refuses the start", () => {
    const t = setup();
    const warnings: string[] = [];
    (t.bb.log as { warn: (message: string) => void }).warn = (message) => { warnings.push(message); };
    t.engine.start = (() => { throw new Error("engine closed"); }) as never;
    expect(() => t.start("proj-1", "run-1", "T1", "pm-1")).not.toThrow();
    expect(warnings.join("\n")).toMatch(/could not start the after-acceptance run of T1: engine closed/);
  });
});
