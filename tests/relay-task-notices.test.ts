import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRelay, TASK_NOTICE, type RelayItem } from "../src/rooms/relay/server/relay";
import {
  createAttempt, createRun, listUnreportedTaskOutcomes, markTaskOutcomesReported, openDatabase, pmHasTasksAtWork, setRunThread, transitionAttempt,
  type TaskOutcome,
} from "../src/rooms/storage/database";

/**
 * 2026-10-12 (Клиенты, thr_k3ry5we546): the PM had to set a reminder per batch to learn its tasks' results, 37 such wakes a day
 * on the hub, each a full Opus turn over a ~520k context. One reminder arrived after the PM had done the work itself. Lane Pilot
 * now tells the PM the results by itself, one message for a batch, and closes the reminders they satisfy in the same message.
 */
function harness(options:{ busy?:() => boolean; send?:(threadId:string, text:string) => Promise<void> } = {}) {
  let items:RelayItem[] = [];
  let now = 10_000_000;
  let outcomes:TaskOutcome[] = [];
  let atWork:string[] = [];
  const states:Record<string, string|null> = {};
  const reported:TaskOutcome[] = [];
  const sent:Array<{ threadId:string; text:string }> = [];
  const dropped:string[] = [];
  const relay = createRelay({
    load:async () => structuredClone(items),
    save:async (next) => { items = structuredClone(next); },
    send:async (threadId, text) => { if (options.send) await options.send(threadId, text); sent.push({ threadId, text }); },
    settled:async () => false,
    output:async () => "",
    busy:async () => options.busy?.() ?? false,
    taskStates:async (_project, ids) => Object.fromEntries(ids.map((task) => [task, states[task] ?? null])),
    taskOutcomes:async () => outcomes.filter((row) => !reported.some((done) => done.transitionId === row.transitionId)),
    tasksAtWork:async () => atWork,
    markReported:async (rows) => { reported.push(...rows); },
    scheduleQueued:async () => "qmsg_1",
    dropQueued:async (_thread, id) => { dropped.push(id); return "deleted"; },
    queuedState:async () => "waiting",
    now:() => now,
    log:() => undefined,
  });
  let transition = 0;
  const end = (taskId:string, state:string, reason:string|null = null) => {
    states[taskId] = state;
    outcomes.push({ transitionId:++transition, attemptId:`a-${taskId}`, projectId:"P", pmThreadId:"pm", taskId, state, reason, at:now });
  };
  return {
    relay, sent, dropped, reported, end,
    tick:(ms:number) => { now += ms; },
    work:(...tasks:string[]) => { atWork = tasks; for (const task of tasks) states[task] = "running"; },
    items:() => items,
  };
}

describe("Lane Pilot tells a PM its task results by itself", () => {
  it("a blocked task goes once no other result came in the last minute, in one message with its reason", async () => {
    const h = harness();
    h.work("b");
    h.end("a", "blocked", "needs_human: may I format the test file?");
    await h.relay.sweep();
    expect(h.sent).toEqual([]);

    h.tick(TASK_NOTICE.settleMs);
    await h.relay.sweep();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.threadId).toBe("pm");
    expect(h.sent[0]!.text).toContain("- a — blocked: needs_human: may I format the test file?");
    expect(h.sent[0]!.text).toContain("Still at work: 1 (b)");

    await h.relay.sweep();
    expect(h.sent).toHaveLength(1);
  });

  it("accepted tasks wait while others are at work and then go together", async () => {
    const h = harness();
    h.work("b", "c");
    h.end("a", "accepted");
    h.tick(10 * 60_000);
    h.work("c");
    h.end("b", "accepted");
    h.tick(10 * 60_000);
    await h.relay.sweep();
    expect(h.sent).toEqual([]);

    h.work();
    h.end("c", "accepted");
    h.tick(TASK_NOTICE.quietMs);
    await h.relay.sweep();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toMatch(/- a — accepted\n- b — accepted\n- c — accepted/);
    expect(h.sent[0]!.text).toContain("None of your tasks is at work now.");
  });

  it("a long queue does not hold accepted results for ever", async () => {
    const h = harness();
    h.work("next");
    h.end("a", "accepted");
    h.tick(TASK_NOTICE.maxWaitMs - 1);
    await h.relay.sweep();
    expect(h.sent).toEqual([]);
    h.tick(1);
    await h.relay.sweep();
    expect(h.sent).toHaveLength(1);
  });

  it("waits while the PM is in a turn", async () => {
    let busy = true;
    const h = harness({ busy:() => busy });
    h.end("a", "blocked", "retry limit 2 exhausted");
    h.tick(TASK_NOTICE.urgentMaxMs);
    await h.relay.sweep();
    expect(h.sent).toEqual([]);
    busy = false;
    await h.relay.sweep();
    expect(h.sent).toHaveLength(1);
  });

  it("the PM's reminder on those tasks goes in the same message with its note and closes: one wake, not two", async () => {
    const h = harness();
    await h.relay.remind({ projectId:"P", threadId:"pm", note:"when both end: commit and report", inMinutes:480, taskIds:["ck-05c", "ck-13"] });
    h.work("ck-13");
    h.end("ck-05c", "accepted");
    h.tick(60_000);
    await h.relay.sweep();
    expect(h.sent).toEqual([]);

    h.work();
    h.end("ck-13", "blocked", "retry limit 2 exhausted: missing expected_outputs");
    await h.relay.sweep();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain("- ck-05c — accepted");
    expect(h.sent[0]!.text).toContain("- ck-13 — blocked: retry limit 2 exhausted");
    expect(h.sent[0]!.text).toContain("when both end: commit and report");
    expect(h.dropped).toEqual(["qmsg_1"]);
    expect(h.items().filter((row) => row.kind === "remind" && !row.firedAt)).toEqual([]);

    h.tick(TASK_NOTICE.maxWaitMs);
    await h.relay.sweep();
    expect(h.sent).toHaveLength(1);
  });

  it("canceled tasks alone do not wake the PM; they are marked reported", async () => {
    const h = harness();
    h.end("a", "canceled", "handover");
    h.end("b", "canceled");
    await h.relay.sweep();
    expect(h.sent).toEqual([]);
    expect(h.reported.map((row) => row.taskId).sort()).toEqual(["a", "b"]);
  });

  it("a message with an accepted task sums canceled ones into a count", async () => {
    const h = harness();
    h.end("keep", "accepted");
    h.end("drop-1", "canceled");
    h.end("drop-2", "canceled");
    h.tick(TASK_NOTICE.quietMs);
    await h.relay.sweep();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain("- keep — accepted");
    expect(h.sent[0]!.text).toContain("2 canceled");
    expect(h.sent[0]!.text).not.toContain("drop-1");
    expect(h.sent[0]!.text).not.toContain("drop-2");
  });

  it("drops the results of an archived PM chat at once instead of trying for a day", async () => {
    let tries = 0;
    const h = harness({ send:async () => { tries++; throw new Error("HTTP 409: Thread is archived"); } });
    h.end("a", "accepted");
    h.tick(TASK_NOTICE.quietMs);
    await h.relay.sweep();
    expect(tries).toBe(1);
    expect(h.reported.map((row) => row.taskId)).toEqual(["a"]);
    h.tick(60_000);
    await h.relay.sweep();
    expect(tries).toBe(1);
  });

  it("keeps trying a PM chat that failed for another reason", async () => {
    let tries = 0;
    const h = harness({ send:async () => { tries++; throw new Error("HTTP 503"); } });
    h.end("a", "accepted");
    h.tick(TASK_NOTICE.quietMs);
    await h.relay.sweep();
    h.tick(60_000);
    await h.relay.sweep();
    expect(tries).toBe(2);
    expect(h.reported).toEqual([]);
  });

  it("drops results it could not deliver for a day instead of trying for ever", async () => {
    let busy = true;
    const h = harness({ busy:() => busy });
    h.end("a", "accepted");
    h.tick(TASK_NOTICE.dropAfterMs + 1);
    await h.relay.sweep();
    busy = false;
    await h.relay.sweep();
    expect(h.sent).toEqual([]);
    expect(h.reported.map((row) => row.taskId)).toEqual(["a"]);
  });
});

describe("listUnreportedTaskOutcomes", () => {
  function world() {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "bb");
    setRunThread(db, "run", "pm");
    return db;
  }
  const finish = (db:ReturnType<typeof world>, id:string, task:string, state:"accepted"|"blocked"|"validation_failed", reason?:string) => {
    createAttempt(db, { id, runId:"run", taskId:task });
    transitionAttempt(db, id, "spawn_requested");
    transitionAttempt(db, id, "running");
    transitionAttempt(db, id, state, reason ? { reason } : {});
  };

  it("reports the latest attempt of a task once, skips a retried attempt and a task the PM sent again", async () => {
    const db = world();
    finish(db, "x1", "x", "validation_failed", "check failed");
    createAttempt(db, { id:"x2", runId:"run", taskId:"x" });
    finish(db, "y1", "y", "accepted");
    finish(db, "z1", "z", "blocked", "needs_human: question");
    await new Promise((wake) => setTimeout(wake, 2));
    createAttempt(db, { id:"z2", runId:"run", taskId:"z.2" });

    const rows = listUnreportedTaskOutcomes(db, 0);
    expect(rows.map((row) => [row.taskId, row.state, row.pmThreadId])).toEqual([["y", "accepted", "pm"]]);
    expect(pmHasTasksAtWork(db, "pm").sort()).toEqual(["x", "z.2"]);

    markTaskOutcomesReported(db, rows, Date.now());
    expect(listUnreportedTaskOutcomes(db, 0)).toEqual([]);
  });

  it("a blocked task the PM answered is reported again when it blocks a second time", () => {
    const db = world();
    finish(db, "q1", "q", "blocked", "needs_human: first");
    const first = listUnreportedTaskOutcomes(db, 0);
    expect(first).toHaveLength(1);
    markTaskOutcomesReported(db, first, Date.now());
    transitionAttempt(db, "q1", "running");
    expect(listUnreportedTaskOutcomes(db, 0)).toEqual([]);
    transitionAttempt(db, "q1", "blocked", { reason:"needs_human: second" });
    expect(listUnreportedTaskOutcomes(db, 0).map((row) => row.reason)).toEqual(["needs_human: second"]);
  });
});
