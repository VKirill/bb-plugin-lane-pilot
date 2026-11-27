import { describe, expect, it } from "vitest";
import { computeEnvironmentFingerprint, fallbackRates, nodeCensus } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb, ok, wf } from "../workflow/engine-helpers";

describe("Task 27: nodeCensus filters, durationShare, and fallbackRates", () => {
  it("computes durationShare summing to 1 and filters by runIds and graphVersion", async () => {
    const db = journalDb();
    let clock = 1_000;

    const makeDef = (version: number) =>
      wf({
        id: "census-filter-wf",
        version,
        nodes: [
          { id: "fast_code", type: "action", action: "prep", output: [{ name: "ready", type: "boolean" }] },
          { id: "slow_agent", type: "agent", role: "analyst", prompt: "Analyze {{input.query}}", output: [{ name: "summary", type: "string" }] },
          { id: "done", type: "action", action: "emit", map: { result: "slow_agent.summary" } },
        ],
        edges: [
          { from: "start", to: "fast_code" },
          { from: "fast_code", to: "slow_agent" },
          { from: "slow_agent", to: "done" },
        ],
      });

    const engine = engineOn(
      db,
      {
        prep: ok(() => {
          clock += 50;
          return { ready: true };
        }),
        agent: {
          reentrant: true,
          run: async (ctx) => {
            const delay = ctx.render("{{input.query}}") === "run1" ? 300 : 100;
            clock += delay;
            return {
              output: { summary: "ok", handoff: "done" },
              threadId: `thr-${ctx.runId}`,
              usage: {
                tokens: 500,
                costUsd: 0.01,
                inputTokens: 400,
                outputTokens: 100,
                requestedProvider: "anthropic",
                requestedModel: "claude-sonnet-5-5",
                answeredProvider: "anthropic",
                answeredModel: "claude-sonnet-5-5",
              },
            };
          },
        },
      },
      { now: () => clock },
    );

    const r1 = await engine.start({ workflow: makeDef(1), inputs: { query: "run1" } }).done;
    const r2 = await engine.start({ workflow: makeDef(1), inputs: { query: "run2" } }).done;
    const r3 = await engine.start({ workflow: makeDef(2), inputs: { query: "run3" } }).done;
    expect([r1.status, r2.status, r3.status]).toEqual(["succeeded", "succeeded", "succeeded"]);

    const all = nodeCensus(db, { workflowId: "census-filter-wf" });
    expect(all.reduce((sum, entry) => sum + entry.durationShare, 0)).toBeCloseTo(1, 5);

    const onlyRun1 = nodeCensus(db, { workflowId: "census-filter-wf", runIds: [r1.runId] });
    const byNodeRun1 = Object.fromEntries(onlyRun1.map((entry) => [entry.nodeId, entry]));
    expect(onlyRun1.reduce((sum, entry) => sum + entry.durationShare, 0)).toBeCloseTo(1, 5);
    expect(byNodeRun1.fast_code?.steps).toBe(1);
    expect(byNodeRun1.slow_agent?.steps).toBe(1);
    // fast_code = 50ms, slow_agent = 300ms, done = 0ms -> total 350ms
    expect(byNodeRun1.fast_code?.durationShare).toBeCloseTo(50 / 350, 5);
    expect(byNodeRun1.slow_agent?.durationShare).toBeCloseTo(300 / 350, 5);

    const v2Only = nodeCensus(db, { workflowId: "census-filter-wf", graphVersion: 2 });
    const byNodeV2 = Object.fromEntries(v2Only.map((entry) => [entry.nodeId, entry]));
    expect(byNodeV2.slow_agent?.steps).toBe(1);
    expect(byNodeV2.slow_agent?.durationShare).toBeCloseTo(100 / 150, 5);

    expect(nodeCensus(db, { workflowId: "census-filter-wf", runIds: [] })).toEqual([]);
  });

  it("computes rolling fallbackRates for script/plan nodes and returns null when n < 10", async () => {
    const db = journalDb();
    const fp = computeEnvironmentFingerprint();
    let clock = 5_000;

    const definition = wf({
      id: "fallback-rate-wf",
      version: 3,
      nodes: [
        {
          id: "script_step",
          type: "agent",
          role: "analyst",
          form: "script",
          fallback: "agent",
          script: { cmd: process.execPath, args: ["-e", "console.log('{}')"], fingerprint: fp },
          verify: "script_step.out != ''",
          prompt: "Handle {{input.query}}",
          output: [{ name: "out", type: "string" }],
        },
        {
          id: "plan_step",
          type: "agent",
          role: "analyst",
          form: "plan",
          plan: { steps: ["Step 1", "Step 2"] },
          prompt: "Plan {{input.query}}",
          output: [{ name: "out", type: "string" }],
        },
        {
          id: "agent_step",
          type: "agent",
          role: "analyst",
          prompt: "Plain {{input.query}}",
          output: [{ name: "out", type: "string" }],
        },
        { id: "done", type: "action", action: "emit", map: { result: "agent_step.out" } },
      ],
      edges: [
        { from: "start", to: "script_step" },
        { from: "script_step", to: "plan_step" },
        { from: "plan_step", to: "agent_step" },
        { from: "agent_step", to: "done" },
      ],
    });

    let runIdx = 0;
    const engine = engineOn(
      db,
      {
        "builtin:script": {
          reentrant: true,
          run: async () => {
            clock += 10;
            // First 3 of 12 runs fall back; remaining 9 succeed directly as script.
            if (runIdx <= 3) throw new Error("script hiccup");
            return { output: { out: "script-ok", handoff: "ok" } };
          },
        },
        agent: {
          reentrant: true,
          run: async (ctx) => {
            clock += 20;
            if (ctx.nodeId === "plan_step" && ctx.form === "plan" && runIdx <= 2) {
              throw new Error("plan hiccup");
            }
            return {
              output: { out: `agent-${ctx.nodeId}`, handoff: "ok" },
              usage: {
                tokens: 100,
                costUsd: 0.001,
                requestedModel: "claude-sonnet-5-5",
                answeredModel: "claude-sonnet-5-5",
              },
            };
          },
        },
      },
      { now: () => clock, environmentFingerprint: fp },
    );

    // Run 9 times first: both script_step and plan_step have n = 9 (< 10) -> rate: null
    for (let i = 1; i <= 9; i += 1) {
      runIdx = i;
      const summary = await engine.start({ workflow: definition, inputs: { query: `q${i}` } }).done;
      expect(summary.status).toBe("succeeded");
    }

    const underMin = fallbackRates(db, { workflowId: "fallback-rate-wf" });
    expect(underMin.find((r) => r.nodeId === "script_step")).toEqual({
      nodeId: "script_step",
      graphVersion: 3,
      form: "script",
      n: 9,
      fallbacks: 3,
      rate: null,
    });
    expect(underMin.find((r) => r.nodeId === "plan_step")).toEqual({
      nodeId: "plan_step",
      graphVersion: 3,
      form: "plan",
      n: 9,
      fallbacks: 2,
      rate: null,
    });
    // Plain agent and action nodes are excluded.
    expect(underMin.find((r) => r.nodeId === "agent_step" || r.nodeId === "done")).toBeUndefined();

    // Run 3 more times -> n = 12 for script_step with 3 fallbacks -> rate = 0.25
    for (let i = 10; i <= 12; i += 1) {
      runIdx = i;
      const summary = await engine.start({ workflow: definition, inputs: { query: `q${i}` } }).done;
      expect(summary.status).toBe("succeeded");
    }

    const fullRates = fallbackRates(db, { workflowId: "fallback-rate-wf" });
    expect(fullRates.find((r) => r.nodeId === "script_step")).toEqual({
      nodeId: "script_step",
      graphVersion: 3,
      form: "script",
      n: 12,
      fallbacks: 3,
      rate: 0.25,
    });
    expect(fullRates.find((r) => r.nodeId === "plan_step")).toEqual({
      nodeId: "plan_step",
      graphVersion: 3,
      form: "plan",
      n: 12,
      fallbacks: 2,
      rate: 2 / 12,
    });

    // Window = 10 looks only at the last 10 steps (runs 3..12 -> only 1 fallback for script_step, 0 for plan_step).
    const windowed = fallbackRates(db, { workflowId: "fallback-rate-wf", window: 10 });
    expect(windowed.find((r) => r.nodeId === "script_step")).toEqual({
      nodeId: "script_step",
      graphVersion: 3,
      form: "script",
      n: 10,
      fallbacks: 1,
      rate: 0.1,
    });
    expect(windowed.find((r) => r.nodeId === "plan_step")).toEqual({
      nodeId: "plan_step",
      graphVersion: 3,
      form: "plan",
      n: 10,
      fallbacks: 0,
      rate: 0,
    });
  });
});
