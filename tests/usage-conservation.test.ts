import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { NodeExecutor } from "@lane-pilot/workflow-engine";
import { openDatabase } from "../src/rooms/storage/database";
import { threadUsage } from "../src/rooms/usage/server/token-usage";
import { withUsage } from "../src/rooms/usage/server/step-usage";
import { markAttemptStart } from "../src/rooms/writer/server/attempt-marker";
import { taskThreadWindows, taskUsage } from "../src/rooms/writer/server/attempt-usage";
import { lpTaskPipelineExecutor } from "../src/rooms/writer/server/dispatch-workflow";
import { engineOn, journalDb, ok, rows, wf } from "./workflow/engine-helpers";

/**
 * F5 of Astra's review (2026-10-27): a step is charged the turns it caused, not a thread's total. A sticky writer carries many tasks in one
 * thread; the numbers charged to the tasks must add up to the thread's real total (nothing twice, nothing lost), also when the plugin reloads
 * and reads them again, and a step that failed after spending, or a child graph that did, is charged once.
 */
const turn = (seq: number, at: number, tokens: number, cumulative: number) => ({
  seq, createdAt: at, type: "thread/tokenUsage/updated",
  data: { turnId: `turn-${seq}`, tokenUsage: {
    last: { inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0, totalTokens: tokens },
    total: { inputTokens: cumulative, outputTokens: 0, cachedInputTokens: 0, totalTokens: cumulative } } },
});

/** One sticky writer thread: task A began it (100 + 20 tokens), tasks B (50) and C (30) went on in it, each after its own start marker. */
function stickyWorld() {
  const events = {
    thr_T: [turn(1, 1_100, 100, 100), turn(2, 1_300, 20, 120), turn(3, 2_100, 50, 170), turn(4, 3_100, 30, 200)],
    thr_critic: [turn(1, 1_500, 7, 7)],
  } as Record<string, unknown[]>;
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: { events: { list: async (args: { threadId: string; afterSeq?: string; limit?: string }) => {
      const after = args.afterSeq ? Number(args.afterSeq) : 0;
      return (events[args.threadId] ?? []).filter((event) => Number((event as { seq: number }).seq) > after).slice(0, Number(args.limit ?? 100));
    } } } } as never,
  });
  const db = openDatabase(bb);
  db.exec("PRAGMA foreign_keys=OFF");
  const attempt = db.prepare("INSERT INTO lane_pilot_attempt (id, run_id, task_id, thread_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)");
  attempt.run("a1", "run1", "taskA", "thr_T", "accepted", 1_000, 1_400);
  attempt.run("b1", "run1", "taskB", "thr_T", "accepted", 1_900, 2_200);
  attempt.run("c1", "run1", "taskC", "thr_T", "accepted", 2_900, 3_200);
  return { bb, db };
}

describe("a sticky writer's thread is charged to the tasks by their own turns", () => {
  it("two tasks that went on in one thread, and a third, add up to the thread's real total, also when read again after a reload", async () => {
    const { bb, db } = stickyWorld();
    // continueInThread leaves the marker before it sends the turn; a reload that runs it again must not move it.
    await markAttemptStart(bb.storage.kv, "b1", 2_000);
    await markAttemptStart(bb.storage.kv, "c1", 3_000);
    await markAttemptStart(bb.storage.kv, "b1", 9_999);

    const real = await threadUsage(bb, "thr_T");
    expect(real.tokens).toBe(200);

    const charged = async () => {
      const [a, b, c] = await Promise.all(["taskA", "taskB", "taskC"].map((task) => taskUsage(bb, db, "run1", task)));
      return [a!.usage!.tokens, b!.usage!.tokens, c!.usage!.tokens];
    };
    expect(await charged()).toEqual([120, 50, 30]);
    // The reload: the same reading again gives the same numbers, and they still add up to the thread's total.
    const again = await charged();
    expect(again).toEqual([120, 50, 30]);
    expect(again.reduce((sum, tokens) => sum + tokens, 0)).toBe(real.tokens);

    // What the old reading did: the whole thread for every task.
    const whole = await Promise.all(["thr_T", "thr_T", "thr_T"].map((id) => withUsage(bb, id)));
    expect(whole.reduce((sum, row) => sum + row.usage!.tokens, 0)).toBe(600);
  });

  it("the pipeline's waiting step of a reloaded dispatch (no runtime) still reads what its task spent, from the plugin's own bb", async () => {
    const { bb, db } = stickyWorld();
    await markAttemptStart(bb.storage.kv, "b1", 2_000);
    await markAttemptStart(bb.storage.kv, "c1", 3_000);
    const poll = lpTaskPipelineExecutor(engineOn(db), bb).poll!;
    const settled = await poll({ runId: "wf1", stepKey: "task", nodeId: "task", await: { kind: "attempt", detail: { runId: "run1", taskId: "taskB" } } }, { runtime: undefined, node: {} as never });
    expect(settled).toMatchObject({ output: { reply: { taskId: "taskB", state: "accepted" } }, usage: { tokens: 50 }, threadId: "thr_T" });
  });

  it("a task's retry in the same thread joins its window; a task that began the thread has no marker", async () => {
    const { bb, db } = stickyWorld();
    db.prepare("INSERT INTO lane_pilot_attempt (id, run_id, task_id, thread_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run("a2", "run1", "taskA", "thr_T", "accepted", 2_950, 3_300);
    await markAttemptStart(bb.storage.kv, "b1", 2_000);
    await markAttemptStart(bb.storage.kv, "a2", 3_000);
    expect(await taskThreadWindows(bb.storage.kv, db, "run1", "taskA")).toEqual([{ id: "thr_T", until: 2_000 }, { id: "thr_T", since: 3_000 }]);
    const [a, b] = await Promise.all(["taskA", "taskB"].map((task) => taskUsage(bb, db, "run1", task)));
    expect([a!.usage!.tokens, b!.usage!.tokens]).toEqual([120 + 30, 50]);
  });

  it("a thread that reports no usage is `unknown`, never free, and a window with no turns spent 0", async () => {
    const { bb } = stickyWorld();
    expect((await withUsage(bb, { id: "thr_T", since: 5_000 })).usage).toEqual({ tokens: 0, costUsd: 0 });
    expect((await withUsage(bb, "thr_nothing")).usage).toMatchObject({ unknown: true });
  });
});

describe("the engine charges a step that failed after spending, and a failed child, once", () => {
  const failing = (usage: { tokens: number; costUsd: number }): NodeExecutor => ({
    reentrant: true, run: async () => { throw Object.assign(new Error("helper failed"), { usage }); },
  });

  it("a step whose error carries what its helper spent is charged for it", async () => {
    const db = journalDb();
    const summary = await engineOn(db, { search: failing({ tokens: 400, costUsd: 0.4 }), write: ok(() => ({ text: "w" })) }).start({ workflow: wf(), inputs: { query: "q" } }).done;
    expect(summary.status).toBe("failed");
    expect(rows<{ tokens_used: number; cost_micro_usd: number }>(db, "SELECT tokens_used, cost_micro_usd FROM lane_pilot_wf_run")[0]).toEqual({ tokens_used: 400, cost_micro_usd: 400_000 });
  });

  it("a child graph that failed after spending is carried up to its parent once, however many times the parent asks", async () => {
    const db = journalDb();
    const leaf = wf({
      id: "leaf", inputs: [{ name: "query", type: "string" }], outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "write", type: "action", action: "leaf-write", output: [{ name: "text", type: "string" }] }, { id: "boom", type: "action", action: "boom", output: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "write" }, { from: "write", to: "boom" }, { from: "boom", to: "end", with: { result: "boom.text" } }],
    });
    const parent = wf({
      id: "parent", inputs: [{ name: "query", type: "string" }], outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "call", type: "subworkflow", workflow: "leaf", inputs: { query: "$inputs.query" }, output: [{ name: "result", type: "string" }] }],
      edges: [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }],
    });
    const executors = {
      "leaf-write": { reentrant: true, run: async () => ({ output: { text: "x" }, usage: { tokens: 700, costUsd: 0.7 } }) } as NodeExecutor,
      boom: { reentrant: true, run: async () => { throw new Error("boom"); } } as NodeExecutor,
    };
    const first = engineOn(db, executors, { resolveWorkflow: (id) => (id === "leaf" ? leaf : null) });
    const summary = await first.start({ workflow: parent, inputs: { query: "q" } }).done;
    expect(summary.status).toBe("failed");
    const total = () => rows<{ tokens_used: number }>(db, "SELECT tokens_used FROM lane_pilot_wf_run WHERE depth=0")[0]!.tokens_used;
    expect(total()).toBe(700);

    // A reload: a new engine over the same journal is asked about the same failed child again (the parent's poll does exactly this).
    const reloaded = engineOn(db, executors, { resolveWorkflow: (id) => (id === "leaf" ? leaf : null) });
    const child = rows<{ id: string }>(db, "SELECT id FROM lane_pilot_wf_run WHERE depth=1")[0]!.id;
    const ask = () => (reloaded as unknown as { childOutcome(summary: unknown, node: unknown): unknown }).childOutcome((reloaded as unknown as { summary(id: string): unknown }).summary(child), { workflow: "leaf" });
    expect(ask).toThrow("subworkflow leaf");
    expect(ask).toThrow("subworkflow leaf");
    expect(total()).toBe(700);
  });
});
