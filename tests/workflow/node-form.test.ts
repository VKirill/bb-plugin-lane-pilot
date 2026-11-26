import { describe, expect, it, vi } from "vitest";
import { roleModelKey } from "@lane-pilot/models";
import {
  applyDraftOps,
  computeEnvironmentFingerprint,
  loadWorkflow,
  parseWorkflow,
  runStepFacts,
  type GraphNode,
  type StepContext,
} from "@lane-pilot/workflow-engine";
import { agentRequest, withResolvedModel, type HelperRequest } from "../../src/rooms/workflow/server/services/workflow-agent";
import { codes, workflow } from "./fixtures";
import { engineOn, journalDb, rows, wf } from "./engine-helpers";

function runtime(settings: Record<string, unknown> = {}) {
  return {
    pmThreadId: "pm-thread",
    projectId: "p",
    runId: "r",
    ctx: {
      db: { prepare: () => ({ get: () => undefined }) },
      log: vi.fn(),
      effectiveProjectSettings: async () => ({ values: settings }),
      ownedAgents: async () => ({}),
      bb: {
        sdk: { threads: { defaultExecutionOptions: async () => ({}) } },
        log: { warn: vi.fn() },
        storage: { kv: { get: async () => null, set: async () => undefined } },
      },
    },
    services: {},
  };
}

describe("Task 29: node form (agent | plan | script) with fallback", () => {
  it("defaults form to agent and rejects script without verify, missing fingerprint, or missing plan", () => {
    const defaultParsed = parseWorkflow(workflow({
      nodes: [
        { id: "work", type: "agent", role: "analyst", prompt: "Analyze", output: [{ name: "res", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "work.res" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    }));
    const workNode = defaultParsed.nodes.find((n) => n.id === "work") as Extract<GraphNode, { type: "agent" }>;
    expect(workNode.form).toBe("agent");

    const noVerify = loadWorkflow(workflow({
      nodes: [
        {
          id: "work",
          type: "agent",
          role: "analyst",
          form: "script",
          script: { cmd: "node", args: ["-e", "console.log('{}')"], fingerprint: "fp-1" },
          prompt: "Analyze",
          output: [{ name: "res", type: "string" }],
        },
        { id: "done", type: "action", action: "emit", map: { result: "work.res" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    }));
    expect(noVerify.ok).toBe(false);
    if (!noVerify.ok) expect(codes(noVerify.problems)).toContain("script_verify_missing");

    const noFingerprint = loadWorkflow(workflow({
      nodes: [
        {
          id: "work",
          type: "agent",
          role: "analyst",
          form: "script",
          script: { cmd: "node", args: ["-e", "console.log('{}')"] },
          verify: "work.res != ''",
          prompt: "Analyze",
          output: [{ name: "res", type: "string" }],
        },
        { id: "done", type: "action", action: "emit", map: { result: "work.res" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    }));
    expect(noFingerprint.ok).toBe(false);
    if (!noFingerprint.ok) expect(codes(noFingerprint.problems)).toContain("script_fingerprint_missing");

    const noPlan = loadWorkflow(workflow({
      nodes: [
        { id: "work", type: "agent", role: "analyst", form: "plan", prompt: "Analyze", output: [{ name: "res", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "work.res" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    }));
    expect(noPlan.ok).toBe(false);
    if (!noPlan.ok) expect(codes(noPlan.problems)).toContain("plan_missing");

    const badFallback = loadWorkflow(workflow({
      nodes: [
        { id: "work", type: "agent", role: "analyst", form: "agent", fallback: "agent", prompt: "Analyze", output: [{ name: "res", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "work.res" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    }));
    expect(badFallback.ok).toBe(false);
    if (!badFallback.ok) expect(codes(badFallback.problems)).toContain("form_fallback_invalid");
  });

  it("only allows the evolution gate to change a node's form in draft patches", () => {
    const def = workflow({
      nodes: [
        { id: "work", type: "agent", role: "analyst", prompt: "Analyze", output: [{ name: "res", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "work.res" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    });
    const refused = applyDraftOps(def, [{ op: "update_node", id: "work", set: { form: "script" } }]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refused[0]?.reason).toMatch(/evolution gate/i);

    const refusedAdd = applyDraftOps(def, [{ op: "add_node", node: { id: "fast", type: "agent", form: "plan" } }]);
    expect(refusedAdd.ok).toBe(false);

    const allowed = applyDraftOps(def, [{ op: "update_node", id: "work", set: { form: "plan", plan: "1. Read\n2. Output" } }], { evolutionGate: true });
    expect(allowed.ok).toBe(true);
  });

  it("script success runs stored parameterised command without calling agent and records step facts", async () => {
    const db = journalDb();
    const fp = computeEnvironmentFingerprint();
    const infoLogs: string[] = [];
    const warnLogs: string[] = [];
    const agentRun = vi.fn(async () => ({
      output: { summary: "from-agent", handoff: "agent" },
      usage: { tokens: 100, costUsd: 0.01, answeredModel: "claude-sonnet-5-5" },
    }));

    const definition = wf({
      budget: { maxCostUsd: 1.0 },
      nodes: [
        {
          id: "work",
          type: "agent",
          role: "analyst",
          form: "script",
          fallback: "agent",
          script: {
            cmd: process.execPath,
            args: ["-e", "const p = JSON.parse(process.env.LP_SCRIPT_PARAMS || '{}'); console.log(JSON.stringify({ summary: 'script:' + p.q }));"],
            params: { q: "{{input.query}}" },
            fingerprint: fp,
          },
          verify: "work.summary != ''",
          prompt: "Analyze {{input.query}}",
          output: [{ name: "summary", type: "string" }],
        },
        { id: "done", type: "action", action: "emit", map: { result: "work.summary" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    });

    const engine = engineOn(
      db,
      { agent: { reentrant: true, run: agentRun } },
      {
        logger: {
          info: (msg) => infoLogs.push(msg),
          warn: (msg) => warnLogs.push(msg),
        },
      },
    );

    const summary = await engine.start({ workflow: definition, inputs: { query: "hello" } }).done;
    expect(summary.status).toBe("succeeded");
    expect(summary.output).toEqual({ result: "script:hello" });
    expect(agentRun).not.toHaveBeenCalled();

    const stepRow = rows(db, "SELECT form_used, fallback_taken, environment_fingerprint, cost_micro_usd, cost_state FROM lane_pilot_wf_step WHERE run_id=? AND node_id='work'", summary.runId)[0]!;
    expect(stepRow).toEqual({
      form_used: "script",
      fallback_taken: null,
      environment_fingerprint: fp,
      cost_micro_usd: 0,
      cost_state: "measured",
    });

    const facts = runStepFacts(engine, summary.runId);
    expect(facts.find((f) => f.nodeId === "work")).toMatchObject({
      formUsed: "script",
      fallbackTaken: null,
      environmentFingerprint: fp,
      costState: "measured",
    });
    expect(infoLogs.some((line) => line.includes("wf.form node=work form=script"))).toBe(true);
    expect(warnLogs).toEqual([]);
  });

  it("script failure and verify failure drop to agent in the same step and record fallback", async () => {
    const db = journalDb();
    const fp = computeEnvironmentFingerprint();
    const infoLogs: string[] = [];
    const warnLogs: string[] = [];
    const formsSeen: Array<string | undefined> = [];

    const definition = wf({
      nodes: [
        {
          id: "work",
          type: "agent",
          role: "analyst",
          form: "script",
          fallback: "agent",
          script: {
            cmd: process.execPath,
            args: ["-e", "process.stderr.write('boom'); process.exit(2);"],
            fingerprint: fp,
          },
          verify: { requiredFields: ["summary"], expr: "summary != 'bad'" },
          prompt: "Analyze {{input.query}}",
          output: [{ name: "summary", type: "string" }],
        },
        { id: "done", type: "action", action: "emit", map: { result: "work.summary" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    });

    const engine = engineOn(
      db,
      {
        agent: {
          reentrant: true,
          run: async (ctx) => {
            formsSeen.push(ctx.form);
            return {
              output: { summary: "agent-recovered", handoff: "done" },
              usage: { tokens: 120, costUsd: 0.001, answeredModel: "claude-sonnet-5-5" },
            };
          },
        },
      },
      {
        logger: {
          info: (msg) => infoLogs.push(msg),
          warn: (msg) => warnLogs.push(msg),
        },
      },
    );

    const summary = await engine.start({ workflow: definition, inputs: { query: "fail" } }).done;
    expect(summary.status).toBe("succeeded");
    expect(summary.output).toEqual({ result: "agent-recovered" });
    expect(formsSeen).toEqual(["agent"]);

    const stepRow = rows(db, "SELECT form_used, fallback_taken, environment_fingerprint FROM lane_pilot_wf_step WHERE run_id=? AND node_id='work'", summary.runId)[0]!;
    expect(stepRow).toEqual({
      form_used: "agent",
      fallback_taken: "script->agent",
      environment_fingerprint: fp,
    });
    expect(infoLogs.some((line) => line.includes("wf.form node=work form=script"))).toBe(true);
    expect(infoLogs.some((line) => line.includes("wf.form node=work form=agent"))).toBe(true);
    expect(warnLogs.some((line) => line.includes("fallback node=work from=script to=agent"))).toBe(true);

    // Now test mechanical verify failure when script exits 0 but verify fails.
    const verifyFailDef = wf({
      nodes: [
        {
          id: "work",
          type: "agent",
          role: "analyst",
          form: "script",
          fallback: "agent",
          script: {
            cmd: process.execPath,
            args: ["-e", "console.log(JSON.stringify({ summary: 'bad' }))"],
            fingerprint: fp,
          },
          verify: "summary != 'bad'",
          prompt: "Analyze {{input.query}}",
          output: [{ name: "summary", type: "string" }],
        },
        { id: "done", type: "action", action: "emit", map: { result: "work.summary" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    });
    const summary2 = await engine.start({ workflow: verifyFailDef, inputs: { query: "verify-fail" } }).done;
    expect(summary2.status).toBe("succeeded");
    expect(summary2.output).toEqual({ result: "agent-recovered" });
    const row2 = rows(db, "SELECT form_used, fallback_taken FROM lane_pilot_wf_step WHERE run_id=? AND node_id='work'", summary2.runId)[0]!;
    expect(row2).toEqual({ form_used: "agent", fallback_taken: "script->agent" });
  });

  it("drops one level at a time through script -> plan -> agent", async () => {
    const db = journalDb();
    const fp = computeEnvironmentFingerprint();
    const warnLogs: string[] = [];
    const seen: Array<string | undefined> = [];

    const definition = wf({
      nodes: [
        {
          id: "work",
          type: "agent",
          role: "analyst",
          form: "script",
          fallback: "plan",
          script: {
            cmd: process.execPath,
            args: ["-e", "process.exit(1)"],
            fingerprint: fp,
          },
          plan: { steps: ["Read {{input.query}}", "Return summary"] },
          verify: "work.summary != ''",
          prompt: "Analyze {{input.query}}",
          output: [{ name: "summary", type: "string" }],
        },
        { id: "done", type: "action", action: "emit", map: { result: "work.summary" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    });

    const engine = engineOn(
      db,
      {
        agent: {
          reentrant: true,
          run: async (ctx) => {
            seen.push(ctx.form);
            if (ctx.form === "plan") throw new Error("plan failed");
            return {
              output: { summary: "full-agent", handoff: "done" },
              usage: { tokens: 80, costUsd: 0.001, answeredModel: "claude-opus-5-5" },
            };
          },
        },
      },
      { logger: { warn: (msg) => warnLogs.push(msg) } },
    );

    const summary = await engine.start({ workflow: definition, inputs: { query: "cascade" } }).done;
    expect(summary.status).toBe("succeeded");
    expect(summary.output).toEqual({ result: "full-agent" });
    expect(seen).toEqual(["plan", "agent"]);
    expect(warnLogs.some((line) => line.includes("fallback node=work from=script to=plan"))).toBe(true);
    expect(warnLogs.some((line) => line.includes("fallback node=work from=plan to=agent"))).toBe(true);

    const stepRow = rows(db, "SELECT form_used, fallback_taken FROM lane_pilot_wf_step WHERE run_id=? AND node_id='work'", summary.runId)[0]!;
    expect(stepRow).toEqual({ form_used: "agent", fallback_taken: "script->plan->agent" });
  });

  it("fingerprint mismatch skips the script without running it and falls back", async () => {
    const db = journalDb();
    const warnLogs: string[] = [];
    const scriptRan = vi.fn(async () => ({ output: { summary: "should-not-run" } }));
    const agentRun = vi.fn(async () => ({
      output: { summary: "from-agent", handoff: "done" },
      usage: { tokens: 50, costUsd: 0.001, answeredModel: "claude-sonnet-5-5" },
    }));

    const definition = wf({
      nodes: [
        {
          id: "work",
          type: "agent",
          role: "analyst",
          form: "script",
          fallback: "agent",
          script: {
            cmd: process.execPath,
            args: ["-e", "console.log(JSON.stringify({ summary: 'nope' }))"],
            fingerprint: "stale-fingerprint-v0",
          },
          verify: "work.summary != ''",
          prompt: "Analyze {{input.query}}",
          output: [{ name: "summary", type: "string" }],
        },
        { id: "done", type: "action", action: "emit", map: { result: "work.summary" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    });

    const engine = engineOn(
      db,
      {
        "builtin:script": { reentrant: true, run: scriptRan },
        agent: { reentrant: true, run: agentRun },
      },
      {
        environmentFingerprint: "live-fingerprint-v2",
        logger: { warn: (msg) => warnLogs.push(msg) },
      },
    );

    const summary = await engine.start({ workflow: definition, inputs: { query: "fp" } }).done;
    expect(summary.status).toBe("succeeded");
    expect(summary.output).toEqual({ result: "from-agent" });
    expect(scriptRan).not.toHaveBeenCalled();
    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(warnLogs.some((line) => line.includes("fingerprint mismatch") && line.includes("script skipped"))).toBe(true);
    expect(warnLogs.some((line) => line.includes("fallback node=work from=script to=agent reason=fingerprint_mismatch"))).toBe(true);

    const stepRow = rows(db, "SELECT form_used, fallback_taken, environment_fingerprint FROM lane_pilot_wf_step WHERE run_id=? AND node_id='work'", summary.runId)[0]!;
    expect(stepRow).toEqual({
      form_used: "agent",
      fallback_taken: "script->agent",
      environment_fingerprint: "live-fingerprint-v2",
    });
  });

  it("plan form injects the saved plan and selects a small model in workflow-agent", async () => {
    const flow = parseWorkflow(workflow({
      nodes: [
        {
          id: "work",
          type: "agent",
          role: "analyst",
          form: "plan",
          plan: { steps: ["Load {{input.query}}", "Summarize concisely"] },
          prompt: "Handle {{input.query}}",
          output: [{ name: "summary", type: "string" }],
        },
        { id: "done", type: "action", action: "emit", map: { result: "work.summary" } },
      ],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "done" }],
    }));
    const node = flow.nodes.find((n) => n.id === "work") as Extract<GraphNode, { type: "agent" }>;
    const rt = runtime({ [roleModelKey("analyst")]: { model: "claude-opus-5-5" } });

    const planCtx = {
      runtime: rt,
      workflow: flow,
      node,
      nodeId: "work",
      runId: "wfrun",
      stepKey: "work#1",
      spawnKey: "k",
      mode: "standard",
      form: "plan",
      signal: new AbortController().signal,
      input: { with: {}, via: { mode: "artifact", fromStep: null } },
      goals: [],
      reground: false,
      resolve: () => "q-val",
      render: (text: string) => text.replace("{{input.query}}", "q-val"),
      template: (value: unknown) => value,
    } as unknown as StepContext<never>;

    const req: HelperRequest = agentRequest(planCtx as never, node);
    expect(req.form).toBe("plan");
    expect(req.prompt).toContain("<saved_plan>");
    expect(req.prompt).toContain("1. Load q-val");
    expect(req.prompt).toContain("2. Summarize concisely");

    const resolved = await withResolvedModel(req);
    expect(resolved.provider).toBe("claude-code");
    expect(resolved.model).toBe("claude-haiku-5-5");

    // In agent form on the same node/role, it keeps the role's strong model.
    const agentCtx = { ...planCtx, form: "agent" } as unknown as StepContext<never>;
    const agentResolved = await withResolvedModel(agentRequest(agentCtx as never, node));
    expect(agentResolved.model).toBe("claude-opus-5-5");
  });
});
