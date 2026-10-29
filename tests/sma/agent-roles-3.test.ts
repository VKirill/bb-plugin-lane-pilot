import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { roleMethod } from "../../src/rooms/critique/role-method";
import { cancelAttemptById } from "../../src/rooms/runs/server/cancel";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage/database";

describe("role methods the brief actually gets", () => {
  it("[sma:k_ag_debugger] [sma:k_d_ref_debug] a debugger is told no fix without a cause and at most three hypotheses; a writer is not", () => {
    const method = roleMethod("debugger").join("\n");
    expect(method).toContain("No fix without a confirmed root cause");
    expect(method).toContain("at most 3 hypotheses");
    expect(roleMethod("writer")).toEqual([]);
  });

  it.todo("[sma:k_ag_debugger] hypotheses are not written to a session file");

  it("[sma:k_ag_uiqa] a browser check that was not run is not a pass, and a write needs a control that reaches it", () => {
    const method = roleMethod("browser-qa").join("\n");
    expect(method).toContain("Silence is never a pass");
    expect(method).toContain("write with no reachable control");
  });

  it.todo("[sma:k_ag_uiqa] no code presses the app's controls or writes UI-QA.md");
  it.todo("[sma:k_ag_uiauditor] no code scores six pillars or writes UI-REVIEW.md");
  it.todo("[sma:k_ag_security] no code checks a plan threat model against the code or writes SECURITY.md");
  it.todo("[sma:k_ag_integration] createBaseline records which checks were red on the base; it does not check that phases connect or that a user flow completes");
  it.todo("[sma:k_ag_docverifier] a citation is judged by Jev, and with Jev off nothing is checked against the code");
  it.todo("[sma:k_ag_lane_tools] an ordinary worker keeps the Agent tool; it is not removed");
  it.todo("[sma:k_ag_doc_tools] plan, design and lessons are not given the Agent tool for exactly their roles");
  it.todo("[sma:k_ag_foreground] a headless session does not kill a subagent at the end of the turn");
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

  it.todo("[sma:m_cd_stop] a turn named before it starts is not remembered, and a running check is not ended");
});
