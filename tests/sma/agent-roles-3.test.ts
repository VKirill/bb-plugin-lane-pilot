import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { roleMethod } from "../../src/rooms/critique/role-method";
import { cancelAttemptById } from "../../src/rooms/runs/server/cancel";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/plugin-db";

describe("role methods the brief actually gets", () => {
  it("[sma:k_ag_debugger] [sma:k_d_ref_debug] a debugger is told no fix without a cause and at most three hypotheses; a writer is not", () => {
    const method = roleMethod("debugger").join("\n");
    expect(method).toContain("No fix without a confirmed root cause");
    expect(method).toContain("at most 3 hypotheses");
    expect(roleMethod("writer")).toEqual([]);
  });


  it("[sma:k_ag_uiqa] a browser check that was not run is not a pass, and a write needs a control that reaches it", () => {
    const method = roleMethod("browser-qa").join("\n");
    expect(method).toContain("Silence is never a pass");
    expect(method).toContain("write with no reachable control");
  });

});

describe("stopping an attempt", () => {
  it("[sma:m_cd_stop] an attempt with no writer is canceled without stopping a thread, and a missing attempt is refused", async () => {
    const stops: string[] = [];
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { stop: async ({ threadId }: { threadId: string }) => { stops.push(threadId); } } } as never });
    const db = openDatabase(bb);
    createRun(db, "run_stop", "project");
    createTask(db, { id: "task_stop", runId: "run_stop", kind: "bb", contract: {} });
    createAttempt(db, { id: "attempt_stop", runId: "run_stop", taskId: "task_stop" });
    let queued = 0;
    const canceled = await cancelAttemptById({ bb, db, cancelQueuedAttempt: () => { queued += 1; return { ok: true, state: "canceled", reason: null }; } } as never, "attempt_stop");
    expect(canceled).toMatchObject({ ok: true, state: "canceled" });
    expect(queued).toBe(1);
    expect(stops).toEqual([]);
    await expect(cancelAttemptById({ bb, db, cancelQueuedAttempt: () => { throw new Error("no attempt"); } } as never, "missing")).resolves.toMatchObject({ ok: false, state: "missing" });
  });

});
