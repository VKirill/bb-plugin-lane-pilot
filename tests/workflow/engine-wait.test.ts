import { describe, expect, it } from "vitest";
import {
  END,
  HUMAN_WAIT_DEFAULT_SEC,
  START,
  humanWaitDeadline,
  loadWorkflow,
  parseWorkflow,
} from "@lane-pilot/workflow-engine";
import { engineOn, journalDb, ok, rows } from "./engine-helpers";

function waitWorkflow(extraParams: Record<string, unknown> = {}) {
  return parseWorkflow({
    id: "wait-test",
    name: { en: "wait-test", ru: "wait-test" },
    description: { en: "wait-test", ru: "wait-test" },
    outputs: [{ name: "branch", type: "string" }, { name: "woke", type: "string" }],
    nodes: [
      {
        id: "wait",
        type: "action",
        uses: "builtin:wait",
        params: { event: "deploy.done", eventKey: "dep-1", durationSec: 10, ...extraParams },
      },
      { id: "on_event", type: "action", action: "emit", map: { branch: "event", woke: "wait.woke" } },
      { id: "on_timeout", type: "action", action: "emit", map: { branch: "timeout", woke: "wait.woke" } },
    ],
    edges: [
      { from: START, to: "wait" },
      { from: "wait", to: "on_event", when: "wait.woke == 'event'" },
      { from: "wait", to: "on_timeout", when: "wait.woke == 'timeout'" },
    ],
  });
}

describe("WorkflowEngine durable waits", () => {
  it("parks builtin:wait with absolute deadline, logs debug/info, and routes an arriving event via when", async () => {
    const db = journalDb();
    let clock = 1_000_000;
    const logs = { debug: [] as string[], info: [] as string[], warn: [] as string[] };
    const engine = engineOn(db, {}, {
      now: () => clock,
      logger: {
        debug: (msg) => logs.debug.push(msg),
        info: (msg) => logs.info.push(msg),
        warn: (msg) => logs.warn.push(msg),
      },
    });

    const handle = engine.start({ workflow: waitWorkflow(), inputs: {} });
    await viWaitFor(() => rows(db, "SELECT state, await_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='wait'", handle.runId)[0]?.state === "waiting");

    const stepRow = rows<{ step_key: string; await_json: string }>(db, "SELECT step_key, await_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='wait'", handle.runId)[0]!;
    const parkedAwait = JSON.parse(stepRow.await_json) as { kind: string; eventKey: string; deadline: number };
    expect(parkedAwait.kind).toBe("deploy.done");
    expect(parkedAwait.eventKey).toBe("dep-1");
    expect(parkedAwait.deadline).toBe(1_010_000);
    expect(logs.debug.some((line) => line.includes(`wf.wait parked step=${handle.runId}/${stepRow.step_key} deadline=1010000`))).toBe(true);

    clock = 1_005_000;
    expect(await engine.wake("deploy.done", "dep-1", { sha: "abc123" })).toBe(1);
    const done = engine.get(handle.runId)!;
    expect(done.status).toBe("succeeded");
    expect(done.output).toEqual({ branch: "event", woke: "event" });
    expect(logs.info.some((line) => line.includes(`wf.wait woke step=${handle.runId}/${stepRow.step_key} by=event`))).toBe(true);
    expect(logs.warn).toEqual([]);
  });

  it("wakes builtin:wait on timeout with timeoutOutput, uses min(until, durationSec), and enforces CAS between wake and poll", async () => {
    const db = journalDb();
    let clock = Date.parse("2026-11-24T12:00:00.000Z");
    const logs = { debug: [] as string[], info: [] as string[], warn: [] as string[] };
    const engine = engineOn(db, {}, {
      now: () => clock,
      logger: {
        debug: (msg) => logs.debug.push(msg),
        info: (msg) => logs.info.push(msg),
        warn: (msg) => logs.warn.push(msg),
      },
    });

    const wfDef = waitWorkflow({ until: "2026-11-24T12:00:04.000Z", durationSec: 30, timeoutOutput: { reason: "clock" } });
    const handle = engine.start({ workflow: wfDef, inputs: {} });
    await viWaitFor(() => rows(db, "SELECT state FROM lane_pilot_wf_step WHERE run_id=? AND node_id='wait'", handle.runId)[0]?.state === "waiting");

    const stepRow = rows<{ step_key: string; await_json: string }>(db, "SELECT step_key, await_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='wait'", handle.runId)[0]!;
    const parked = JSON.parse(stepRow.await_json) as { deadline: number };
    expect(parked.deadline).toBe(Date.parse("2026-11-24T12:00:04.000Z"));

    clock = parked.deadline - 1;
    expect(await engine.poll()).toBe(0);

    clock = parked.deadline;
    expect(await engine.poll()).toBe(1);
    // A late event arriving after timeout already claimed the CAS must lose cleanly.
    expect(await engine.wake("deploy.done", "dep-1", { sha: "late" })).toBe(0);

    const done = engine.get(handle.runId)!;
    expect(done.status).toBe("succeeded");
    expect(done.output).toEqual({ branch: "timeout", woke: "timeout" });
    expect(logs.info.some((line) => line.includes(`wf.wait woke step=${handle.runId}/${stepRow.step_key} by=timeout`))).toBe(true);
  });

  it("never re-runs a waiting executor on resume, keeps original deadline, and warns when overdue", async () => {
    const db = journalDb();
    let clock = 10_000;
    let agentRuns = 0;

    const wfDef = parseWorkflow({
      id: "resume-wait",
      name: { en: "resume-wait", ru: "resume-wait" },
      description: { en: "resume-wait", ru: "resume-wait" },
      outputs: [{ name: "handoff", type: "string" }, { name: "outcome", type: "string" }],
      nodes: [
        {
          id: "task",
          type: "agent",
          role: "worker",
          prompt: "do work",
          timeoutSec: 5,
          out: [
            { name: "outcome", type: "enum", values: ["done", "blocked"] },
            { name: "handoff", type: "string" },
          ],
        },
      ],
      edges: [
        { from: START, to: "task" },
        { from: "task", to: END, with: { handoff: "task.handoff", outcome: "task.outcome" } },
      ],
    });

    const firstEngine = engineOn(db, {
      agent: {
        run: async () => {
          agentRuns += 1;
          return {
            wait: { kind: "lp-task", eventKey: "t-1", deadline: clock + 5_000 },
            timeoutOutput: { outcome: "blocked", handoff: "wait timed out" },
          };
        },
      },
    }, { now: () => clock });

    const started = firstEngine.start({ workflow: wfDef, inputs: {} });
    await viWaitFor(() => rows(db, "SELECT state FROM lane_pilot_wf_step WHERE run_id=? AND node_id='task'", started.runId)[0]?.state === "waiting");
    const taskStepKey = rows<{ step_key: string }>(db, "SELECT step_key FROM lane_pilot_wf_step WHERE run_id=? AND node_id='task'", started.runId)[0]!.step_key;
    firstEngine.dispose();
    expect(agentRuns).toBe(1);

    // Resume before deadline: parked wait stays parked without re-running executor or extending deadline.
    clock = 12_000;
    const midLogs = { debug: [] as string[], info: [] as string[], warn: [] as string[] };
    const secondEngine = engineOn(db, {
      agent: {
        run: async () => {
          agentRuns += 1;
          return { output: { handoff: "should not re-run" } };
        },
      },
    }, {
      now: () => clock,
      logger: { debug: (m) => midLogs.debug.push(m), info: (m) => midLogs.info.push(m), warn: (m) => midLogs.warn.push(m) },
    });
    await secondEngine.resume({ takeOver: true });
    expect(agentRuns).toBe(1);
    expect(midLogs.warn).toEqual([]);
    const storedAfterMid = JSON.parse(rows<{ await_json: string }>(db, "SELECT await_json FROM lane_pilot_wf_step WHERE run_id=? AND step_key=?", started.runId, taskStepKey)[0]!.await_json) as { deadline: number };
    expect(storedAfterMid.deadline).toBe(15_000);
    secondEngine.dispose();

    // Resume past deadline (15_000): logs WARN with late ms and settles with timeoutOutput without calling executor.run.
    clock = 19_250;
    const lateLogs = { debug: [] as string[], info: [] as string[], warn: [] as string[] };
    const thirdEngine = engineOn(db, {
      agent: {
        run: async () => {
          agentRuns += 1;
          return { output: { handoff: "should not re-run" } };
        },
      },
    }, {
      now: () => clock,
      logger: { debug: (m) => lateLogs.debug.push(m), info: (m) => lateLogs.info.push(m), warn: (m) => lateLogs.warn.push(m) },
    });
    await thirdEngine.resume({ takeOver: true });
    await viWaitFor(() => rows(db, "SELECT status FROM lane_pilot_wf_run WHERE id=?", started.runId)[0]?.status === "succeeded");

    expect(agentRuns).toBe(1);
    expect(lateLogs.warn.some((line) => line.includes(`wf.wait overdue on resume step=${started.runId}/${taskStepKey} fired late by 4250ms`))).toBe(true);
    expect(lateLogs.info.some((line) => line.includes(`wf.wait woke step=${started.runId}/${taskStepKey} by=timeout`))).toBe(true);
    const runRow = rows<{ status: string; output_json: string }>(db, "SELECT status, output_json FROM lane_pilot_wf_run WHERE id=?", started.runId)[0]!;
    expect(runRow.status).toBe("succeeded");
    expect(JSON.parse(runRow.output_json)).toEqual({ handoff: "wait timed out", outcome: "blocked" });
  });

  it("computes the 72 h default human wait deadline consistently", async () => {
    expect(HUMAN_WAIT_DEFAULT_SEC).toBe(72 * 3_600);
    expect(humanWaitDeadline(1_000)).toBe(1_000 + 72 * 3_600 * 1000);
    expect(humanWaitDeadline(1_000, 60)).toBe(61_000);
    expect(humanWaitDeadline(1_000, undefined, 1_800)).toBe(1_801_000);

    const db = journalDb();
    let clock = 5_000;
    const engine = engineOn(db, { finish: ok(() => ({ ok: true })) }, { now: () => clock });
    const wfDef = parseWorkflow({
      id: "human-default-deadline",
      name: { en: "human-default-deadline", ru: "human-default-deadline" },
      description: { en: "human-default-deadline", ru: "human-default-deadline" },
      outputs: [{ name: "kind", type: "string" }],
      nodes: [
        { id: "ask", type: "human", role: "owner", question: "Proceed?", out: [{ name: "answer", type: "string" }, { name: "answer_kind", type: "enum", values: ["yes", "timeout"] }] },
      ],
      edges: [
        { from: START, to: "ask" },
        { from: "ask", to: END, with: { kind: "ask.answer_kind" } },
      ],
    });
    const handle = engine.start({ workflow: wfDef, inputs: {} });
    await viWaitFor(() => rows(db, "SELECT state FROM lane_pilot_wf_step WHERE run_id=? AND node_id='ask'", handle.runId)[0]?.state === "waiting");
    const awaitJson = JSON.parse(rows<{ await_json: string }>(db, "SELECT await_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='ask'", handle.runId)[0]!.await_json) as { deadline: number };
    expect(awaitJson.deadline).toBe(5_000 + HUMAN_WAIT_DEFAULT_SEC * 1000);
  });

  it("validates wait deadlines/timeout edges, check skip_out not_run, and judge session isolation", () => {
    const r1 = loadWorkflow({
      id: "bad-wait-1",
      name: { en: "bad", ru: "bad" },
      description: { en: "bad", ru: "bad" },
      outputs: [],
      nodes: [{ id: "wait", type: "action", uses: "builtin:wait", params: { event: "x" } }],
      edges: [{ from: START, to: "wait" }, { from: "wait", to: END, when: "wait.woke == 'event'" }],
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      const codes1 = r1.problems.filter((p) => p.level === "error").map((p) => p.code);
      expect(codes1).toContain("wait_no_deadline");
      expect(codes1).toContain("wait_no_timeout_edge");
    }

    const r2 = loadWorkflow({
      id: "bad-skip",
      name: { en: "bad-skip", ru: "bad-skip" },
      description: { en: "bad-skip", ru: "bad-skip" },
      outputs: [],
      nodes: [{
        id: "qa",
        type: "agent",
        role: "browser-qa",
        prompt: "check ui",
        skip_when: "false",
        skip_out: { status: "pass" },
        out: [{ name: "status", type: "enum", values: ["pass", "rework", "not_run"] }],
      }],
      edges: [{ from: START, to: "qa" }, { from: "qa", to: END }],
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.problems.map((p) => p.code)).toContain("check_skip_pass");

    const r3 = loadWorkflow({
      id: "bad-judge",
      name: { en: "bad-judge", ru: "bad-judge" },
      description: { en: "bad-judge", ru: "bad-judge" },
      outputs: [],
      nodes: [
        { id: "dev", type: "agent", role: "worker", prompt: "code" },
        { id: "critic", type: "agent", role: "code-critic", prompt: "review" },
      ],
      edges: [
        { from: START, to: "dev" },
        { from: "dev", to: "critic", pass: "read-prior-session" },
        { from: "critic", to: END },
      ],
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.problems.map((p) => p.code)).toContain("judge_reads_worker_session");
  });
});

async function viWaitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("timed out waiting for predicate");
    await new Promise((r) => setTimeout(r, 10));
  }
}
