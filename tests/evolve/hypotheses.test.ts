import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { EVOLVE_THRESHOLDS } from "@lane-pilot/contracts";
import type { ModelCatalog } from "@lane-pilot/models";
import {
  computeEnvironmentFingerprint,
  parseWorkflow,
  WorkflowEngine,
  type StepContext,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { EVOLVE_ENABLED_KEY, EVOLVE_GRAPHS_KEY } from "../../src/rooms/evolve";
import {
  addCase,
  addNegative,
  listHypotheses,
  proposeHypotheses,
  queueHypothesis,
  splitForRunId,
} from "../../src/rooms/evolve/server";
import { addRoad, doneRoad, getRoad, listRoad } from "../../src/rooms/lead/server";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { listRunVerdicts, recordOwnerRunVerdict } from "../../src/rooms/workflow/server";

function workingRunIds(prefix: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count; i += 1) {
    const id = `${prefix}-${i}`;
    if (splitForRunId(id) === "working") out.push(id);
  }
  return out;
}

function heldRunId(prefix: string): string {
  for (let i = 0; ; i += 1) {
    const id = `${prefix}-h-${i}`;
    if (splitForRunId(id) !== "working") return id;
  }
}

function makeWf(def: Record<string, unknown>): Workflow {
  return parseWorkflow({
    schemaVersion: 1,
    id: "invoice-send",
    name: "Invoice Send",
    description: { en: "Invoice send", ru: "Отправка счёта" },
    inputs: [{ name: "query", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    nodes: [
      { id: "done", type: "action", action: "emit", map: { result: "'ok'" } },
    ],
    edges: [{ from: "start", to: "done" }],
    ...def,
  });
}

async function seedWorkingRun(
  db: ReturnType<typeof openDatabase>,
  workflow: Workflow,
  opts: {
    runId?: string;
    inputs?: Record<string, unknown>;
    verdict?: "accept" | "reject";
    nodeExecs?: Record<
      string,
      (ctx: StepContext) => Promise<{
        output: Record<string, unknown>;
        usage?: { tokens: number; costUsd: number; inputTokens?: number; outputTokens?: number; requestedModel?: string; answeredModel?: string };
      }>
    >;
    scriptRun?: (ctx: StepContext) => Promise<{ output: Record<string, unknown> }>;
    clockStep?: (ms: number) => void;
    fp?: string;
  } = {},
): Promise<string> {
  const engine = new WorkflowEngine({
    db,
    harnessVersion: "test-1",
    ...(opts.fp ? { environmentFingerprint: opts.fp } : {}),
  });
  engine.register("prep", {
    run: async () => {
      opts.clockStep?.(5);
      return { output: { ready: true } };
    },
  });
  engine.register("emit", {
    run: async (ctx) => ({ output: (ctx.node as { map?: Record<string, unknown> }).map ?? {} }),
  });
  engine.register("builtin:script", {
    reentrant: true,
    run: async (ctx) => {
      if (opts.scriptRun) return opts.scriptRun(ctx);
      return { output: { out: "ok", handoff: "ok" } };
    },
  });
  engine.register("agent", {
    reentrant: true,
    run: async (ctx) => {
      opts.clockStep?.(50);
      const custom = opts.nodeExecs?.[ctx.nodeId];
      if (custom) return custom(ctx);
      return {
        output: { out: "ok", handoff: "ok" },
        usage: {
          tokens: 500,
          costUsd: 0.01,
          inputTokens: 400,
          outputTokens: 100,
          requestedModel: "claude-opus-5-5",
          answeredModel: "claude-opus-5-5",
        },
      };
    },
  });

  const handle = engine.start({
    workflow,
    inputs: opts.inputs ?? { query: "q1" },
  });
  const summary = await handle.done;
  expect(summary.status).toBe("succeeded");
  if (opts.verdict !== undefined) {
    const added = addCase(db, {
      workflowId: workflow.id,
      runId: summary.runId,
      verdict: opts.verdict,
      graphVersion: workflow.version,
    });
    expect(added.added).toBe(true);
  }
  return summary.runId;
}

describe("Task 30: hypothesis generator", () => {
  it("yields a demotion first for a 25% fallback node and bypasses activeCap", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const fp = computeEnvironmentFingerprint();
      const workflow = makeWf({
        version: 1,
        nodes: [
          {
            id: "script_step",
            type: "agent",
            role: "errand",
            form: "script",
            fallback: "plan",
            plan: { steps: ["Step A"] },
            script: { cmd: process.execPath, args: ["-e", "console.log('{}')"], fingerprint: fp },
            verify: "script_step.out != ''",
            prompt: "Handle {{input.query}}",
            out: [{ name: "out", type: "string" }],
          },
          { id: "done", type: "action", action: "emit", map: { result: "script_step.out" } },
        ],
        edges: [
          { from: "start", to: "script_step" },
          { from: "script_step", to: "done" },
        ],
      });

      // Fill activeCap (3) first to prove demotion bypasses the cap.
      for (let i = 0; i < EVOLVE_THRESHOLDS.activeCap; i += 1) {
        expect(
          queueHypothesis(db, {
            workflowId: "invoice-send",
            nodeId: `existing_${i}`,
            armKind: "model",
            variant: { model: `m-${i}` },
            graphVersion: 1,
            source: "census",
          }).ok,
        ).toBe(true);
      }

      // 12 runs with 3 fallbacks = 25% (> 20% fallbackDemote).
      for (let i = 1; i <= 12; i += 1) {
        const shouldFail = i <= 3;
        await seedWorkingRun(db, workflow, {
          fp,
          scriptRun: async () => {
            if (shouldFail) throw new Error("script hiccup");
            return { output: { out: "script-ok", handoff: "ok" } };
          },
        });
      }

      const logs: string[] = [];
      const proposed = await proposeHypotheses(
        { db, workflow, log: { info: (m) => logs.push(`INFO:${m}`), warn: (m) => logs.push(`WARN:${m}`) } },
        { workflowId: "invoice-send", now: 100_000 },
      );

      expect(proposed).toHaveLength(1);
      expect(proposed[0]).toMatchObject({
        workflowId: "invoice-send",
        nodeId: "script_step",
        armKind: "form",
        variant: { form: "plan", fallback: "agent" },
        source: "fallback",
        graphVersion: 1,
      });
      expect(logs).toContain("INFO:evolve propose wf=invoice-send n=1 demote=1 model=0 form=0 check=0");
      expect(listHypotheses(db, { workflowId: "invoice-send" })).toHaveLength(4);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("yields one cheaper-model arm for a dominant stable node and never touches judge/critic roles", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const workflow = makeWf({
        nodes: [
          {
            id: "draft",
            type: "agent",
            role: "analyst", // default claude-opus-5-5 -> cheaper claude-sonnet-5-5
            prompt: "Draft {{input.query}}",
            out: [{ name: "out", type: "string" }],
          },
          {
            id: "review",
            type: "agent",
            role: "code-critic",
            model: "claude-opus-5-5",
            provider: "claude-code",
            allow_same_model: true,
            same_model_reason: "test",
            prompt: "Critique {{draft.out}}",
            out: [{ name: "out", type: "string" }],
          },
          { id: "done", type: "action", action: "emit", map: { result: "review.out" } },
        ],
        edges: [
          { from: "start", to: "draft" },
          { from: "draft", to: "review" },
          { from: "review", to: "done" },
        ],
      });

      const runId = await seedWorkingRun(db, workflow, {
        nodeExecs: {
          draft: async () => ({
            output: { out: "ok", handoff: "done" },
            usage: { tokens: 1000, costUsd: 0.05, requestedModel: "claude-opus-5-5", answeredModel: "claude-opus-5-5" },
          }),
          review: async () => ({
            output: { out: "pass", handoff: "done" },
            usage: { tokens: 1000, costUsd: 0.05, requestedModel: "claude-opus-5-5", answeredModel: "claude-opus-5-5" },
          }),
        },
      });
      // Ensure the run lands in working (re-run or addCase with working id if hash landed in held_out)
      const workIds = workingRunIds("wrk-model", 1);
      db.prepare("UPDATE lane_pilot_wf_run SET id = ? WHERE id = ?").run(workIds[0]!, runId);
      db.prepare("UPDATE lane_pilot_wf_step SET run_id = ? WHERE run_id = ?").run(workIds[0]!, runId);
      addCase(db, { workflowId: "invoice-send", runId: workIds[0]!, verdict: "accept", graphVersion: 1 });

      const catalog: ModelCatalog = {
        hosts: [{ id: "h1", name: "Mini", connected: true }],
        providers: [
          {
            id: "claude-code",
            displayName: "Claude",
            logoUrl: null,
            family: "claude",
            supportsServiceTier: false,
            serviceTiers: [],
            hostIds: ["h1"],
            models: [
              { id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus", efforts: ["high"], defaultEffort: "high", isDefault: true, hostIds: ["h1"] },
              { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5", displayName: "Sonnet", efforts: ["high"], defaultEffort: "high", isDefault: false, hostIds: ["h1"] },
              { id: "claude-haiku-5-5", model: "claude-haiku-5-5", displayName: "Haiku", efforts: ["low"], defaultEffort: "low", isDefault: false, hostIds: ["h1"] },
            ],
          },
          {
            id: "codex",
            displayName: "Codex",
            logoUrl: null,
            family: "gpt",
            supportsServiceTier: false,
            serviceTiers: [],
            hostIds: ["h1"],
            models: [
              { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "Luna", efforts: ["low"], defaultEffort: "low", isDefault: false, hostIds: ["h1"] },
            ],
          },
        ],
        runHostId: "h1",
      };

      const first = await proposeHypotheses({ db, workflow, catalog, hostId: "h1" }, { workflowId: "invoice-send" });
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        nodeId: "draft",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-sonnet-5-5" },
        source: "census",
      });
      // Judge node `review` never gets a model arm.
      expect(first.some((h) => h.nodeId === "review")).toBe(false);

      // When claude-sonnet-5-5 and claude-haiku-5-5 are in negative archive, falls back to cheapest other-family offered on host (gpt-6-luna).
      addNegative(db, { workflowId: "invoice-send", nodeId: "draft", armKind: "model", variant: { provider: "claude-code", model: "claude-sonnet-5-5" }, graphVersion: 1, reason: "rejected" });
      addNegative(db, { workflowId: "invoice-send", nodeId: "draft", armKind: "model", variant: { provider: "claude-code", model: "claude-haiku-5-5" }, graphVersion: 1, reason: "rejected" });
      // Clear previous active hypothesis to free slot
      db.prepare("DELETE FROM lane_pilot_evolve_hypothesis WHERE workflow_id = 'invoice-send'").run();

      const second = await proposeHypotheses({ db, workflow, catalog, hostId: "h1" }, { workflowId: "invoice-send" });
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({
        nodeId: "draft",
        armKind: "model",
        variant: { provider: "codex", model: "gpt-6-luna" },
        source: "census",
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("generates a plan arm from node prompt + up to 3 accepted working outputs and handles helper failure", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const workflow = makeWf({
        nodes: [
          {
            id: "extract",
            type: "agent",
            role: "errand",
            provider: "claude-code",
            model: "claude-haiku-5-5",
            effect: "L", // blocks script arm -> falls back to plan arm
            prompt: "Extract structured fields from {{input.query}}",
            out: [{ name: "out", type: "string" }],
          },
          { id: "done", type: "action", action: "emit", map: { result: "extract.out" } },
        ],
        edges: [
          { from: "start", to: "extract" },
          { from: "extract", to: "done" },
        ],
      });

      const workIds = workingRunIds("wrk-plan", 4);
      for (let i = 0; i < 4; i += 1) {
        const rawId = await seedWorkingRun(db, workflow, {
          nodeExecs: {
            extract: async () => ({
              output: { out: `val-${i}`, handoff: "ok" },
              usage: { tokens: 200, costUsd: 0.005, requestedModel: "claude-haiku-5-5", answeredModel: "claude-haiku-5-5" },
            }),
          },
        });
        db.prepare("UPDATE lane_pilot_wf_run SET id = ? WHERE id = ?").run(workIds[i]!, rawId);
        db.prepare("UPDATE lane_pilot_wf_step SET run_id = ? WHERE run_id = ?").run(workIds[i]!, rawId);
        addCase(db, { workflowId: "invoice-send", runId: workIds[i]!, verdict: "accept", graphVersion: 1 });
      }
      // Also add a held-out run to verify it is never passed to generatePlan.
      const heldId = heldRunId("held-plan");
      const rawHeld = await seedWorkingRun(db, workflow, {
        nodeExecs: {
          extract: async () => ({
            output: { out: "SECRET_HELD_OUTPUT", handoff: "ok" },
            usage: { tokens: 200, costUsd: 0.005, requestedModel: "claude-haiku-5-5", answeredModel: "claude-haiku-5-5" },
          }),
        },
      });
      db.prepare("UPDATE lane_pilot_wf_run SET id = ? WHERE id = ?").run(heldId, rawHeld);
      db.prepare("UPDATE lane_pilot_wf_step SET run_id = ? WHERE run_id = ?").run(heldId, rawHeld);
      addCase(db, { workflowId: "invoice-send", runId: heldId, verdict: "accept", graphVersion: 1 });

      // Failing helper logs WARN and produces no plan hypothesis.
      const warnLogs: string[] = [];
      const failed = await proposeHypotheses(
        {
          db,
          workflow,
          log: { warn: (m) => warnLogs.push(m) },
          generatePlan: async () => { throw new Error("boom"); },
        },
        { workflowId: "invoice-send" },
      );
      expect(failed).toEqual([]);
      expect(warnLogs).toContain("evolve propose skipped wf=invoice-send: helper failed");

      // Working helper receives prompt + up to 3 accepted working outputs (never held-out).
      let seenPrompt = "";
      let seenOutputs: ReadonlyArray<Record<string, unknown>> = [];
      const okRes = await proposeHypotheses(
        {
          db,
          workflow,
          generatePlan: async (inp) => {
            seenPrompt = inp.prompt;
            seenOutputs = inp.outputs;
            return { steps: ["Step 1", "Step 2"] };
          },
        },
        { workflowId: "invoice-send" },
      );
      expect(seenPrompt).toBe("Extract structured fields from {{input.query}}");
      expect(seenOutputs).toHaveLength(3);
      expect(JSON.stringify(seenOutputs)).not.toContain("SECRET_HELD_OUTPUT");
      expect(okRes).toHaveLength(1);
      expect(okRes[0]).toMatchObject({
        nodeId: "extract",
        armKind: "form",
        variant: { form: "plan", fallback: "agent", plan: { steps: ["Step 1", "Step 2"] } },
        source: "census",
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("requires all five §6 conditions for a script arm (each missing one blocks it)", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const fp = computeEnvironmentFingerprint();
      const baseNode = {
        id: "target",
        type: "agent",
        role: "errand",
        provider: "claude-code",
        model: "claude-haiku-5-5",
        effect: "R",
        verify: "target.out != ''",
        script: { cmd: process.execPath, args: ["-e", "console.log('{}')"] },
        prompt: "Run {{input.query}}",
        out: [{ name: "out", type: "string" }],
      };
      const baseWf = makeWf({
        nodes: [
          baseNode,
          { id: "other", type: "agent", role: "errand", provider: "claude-code", model: "claude-haiku-5-5", prompt: "Other", out: [{ name: "out", type: "string" }] },
          { id: "done", type: "action", action: "emit", map: { result: "target.out" } },
        ],
        edges: [
          { from: "start", to: "target" },
          { from: "target", to: "other" },
          { from: "other", to: "done" },
        ],
      });

      const workIds = workingRunIds("wrk-script", 2);
      // Seed 1 working run with target costShare = 0.25 (>= 0.1) and 1 input shape.
      const seedPair = async (
        wf: Workflow,
        runId: string,
        opts: { targetCost: number; otherCost: number; inputs?: Record<string, unknown>; withEffect?: boolean },
      ) => {
        const raw = await seedWorkingRun(db, wf, {
          inputs: opts.inputs ?? { query: "a" },
          nodeExecs: {
            target: async (ctx) => {
              if (opts.withEffect) {
                await ctx.effect("write-draft", "draft", async () => ({ ok: true }));
              }
              return {
                output: { out: "ok", handoff: "ok" },
                usage: { tokens: 100, costUsd: opts.targetCost, requestedModel: "claude-haiku-5-5", answeredModel: "claude-haiku-5-5" },
              };
            },
            other: async () => ({
              output: { out: "ok", handoff: "ok" },
              usage: { tokens: 100, costUsd: opts.otherCost, requestedModel: "claude-haiku-5-5", answeredModel: "claude-haiku-5-5" },
            }),
          },
        });
        db.prepare("UPDATE lane_pilot_wf_run SET id = ? WHERE id = ?").run(runId, raw);
        db.prepare("UPDATE lane_pilot_wf_step SET run_id = ? WHERE run_id = ?").run(runId, raw);
        db.prepare("UPDATE lane_pilot_wf_effect SET run_id = ? WHERE run_id = ?").run(runId, raw);
        addCase(db, { workflowId: wf.id, runId, verdict: "accept", graphVersion: wf.version });
      };

      await seedPair(baseWf, workIds[0]!, { targetCost: 0.2, otherCost: 0.8 });

      // All 5 present -> script arm proposed!
      const allPresent = await proposeHypotheses({ db, workflow: baseWf, computeFingerprint: () => fp }, { workflowId: "invoice-send" });
      expect(allPresent.some((h) => h.nodeId === "target" && h.armKind === "form" && h.variant.form === "script")).toBe(true);
      db.prepare("DELETE FROM lane_pilot_evolve_hypothesis").run();

      // Missing condition 2: no non-LLM verify
      const noVerifyWf = makeWf({
        ...baseWf,
        nodes: [{ ...baseNode, verify: undefined }, baseWf.nodes[1]!, baseWf.nodes[2]!],
      });
      const resNoVerify = await proposeHypotheses({ db, workflow: noVerifyWf, computeFingerprint: () => fp }, { workflowId: "invoice-send" });
      expect(resNoVerify.some((h) => h.variant.form === "script")).toBe(false);

      // Missing condition 5: fingerprint cannot be computed
      const resNoFp = await proposeHypotheses({ db, workflow: baseWf, computeFingerprint: () => "" }, { workflowId: "invoice-send" });
      expect(resNoFp.some((h) => h.variant.form === "script")).toBe(false);

      // Missing condition 4: effect is "L" and no runEffect
      const effectLWf = makeWf({
        ...baseWf,
        nodes: [{ ...baseNode, effect: "L" }, baseWf.nodes[1]!, baseWf.nodes[2]!],
      });
      const resEffectL = await proposeHypotheses({ db, workflow: effectLWf, computeFingerprint: () => fp }, { workflowId: "invoice-send" });
      expect(resEffectL.some((h) => h.variant.form === "script")).toBe(false);

      // Condition 4 satisfied by runEffect even when effect is "L"
      const effectRunId = workingRunIds("wrk-eff", 1)[0]!;
      await seedPair(effectLWf, effectRunId, { targetCost: 0.2, otherCost: 0.8, withEffect: true });
      const resRunEffect = await proposeHypotheses({ db, workflow: effectLWf, computeFingerprint: () => fp }, { workflowId: "invoice-send" });
      expect(resRunEffect.some((h) => h.variant.form === "script")).toBe(true);
      db.prepare("DELETE FROM lane_pilot_evolve_hypothesis").run();
      db.prepare("DELETE FROM lane_pilot_wf_effect").run();
      db.prepare("DELETE FROM lane_pilot_evolve_case WHERE run_id = ?").run(effectRunId);
      db.prepare("DELETE FROM lane_pilot_wf_step WHERE run_id = ?").run(effectRunId);
      db.prepare("DELETE FROM lane_pilot_wf_run WHERE id = ?").run(effectRunId);

      // Missing condition 3: costShare < 0.1 (0.05 / 1.0 = 0.05)
      db.prepare("UPDATE lane_pilot_wf_step SET cost_micro_usd = 50000 WHERE run_id = ? AND node_id = 'target'").run(workIds[0]!);
      db.prepare("UPDATE lane_pilot_wf_step SET cost_micro_usd = 950000 WHERE run_id = ? AND node_id = 'other'").run(workIds[0]!);
      const resLowCost = await proposeHypotheses({ db, workflow: baseWf, computeFingerprint: () => fp }, { workflowId: "invoice-send" });
      expect(resLowCost.some((h) => h.variant.form === "script")).toBe(false);

      // Missing condition 1: inputShapes.size > 1 (two distinct `with` input shapes on target)
      db.prepare("UPDATE lane_pilot_wf_step SET cost_micro_usd = 200000 WHERE run_id = ? AND node_id = 'target'").run(workIds[0]!);
      db.prepare("UPDATE lane_pilot_wf_step SET cost_micro_usd = 800000 WHERE run_id = ? AND node_id = 'other'").run(workIds[0]!);
      await seedPair(baseWf, workIds[1]!, { targetCost: 0.2, otherCost: 0.8 });
      db.prepare("UPDATE lane_pilot_wf_step SET input_json = ? WHERE run_id = ? AND node_id = 'target'").run(
        JSON.stringify({ with: { alpha: 1 } }),
        workIds[0]!,
      );
      db.prepare("UPDATE lane_pilot_wf_step SET input_json = ? WHERE run_id = ? AND node_id = 'target'").run(
        JSON.stringify({ with: { beta: 2 } }),
        workIds[1]!,
      );
      const resMultiShape = await proposeHypotheses({ db, workflow: baseWf, computeFingerprint: () => fp }, { workflowId: "invoice-send" });
      expect(resMultiShape.some((h) => h.variant.form === "script")).toBe(false);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("consumes lead_road branch rows targeting an existing graph and owner wrong_result verdicts", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const workflow = makeWf({
        inputs: [
          { name: "query", type: "string" },
          { name: "amount", type: "number" },
        ],
        nodes: [
          {
            id: "create",
            type: "agent",
            role: "errand",
            provider: "claude-code",
            model: "claude-haiku-5-5",
            prompt: "Create invoice",
            out: [
              { name: "invoice_number", type: "string" },
              { name: "invoice_amount", type: "number" },
            ],
          },
          { id: "done", type: "action", action: "emit", map: { result: "create.invoice_number" } },
        ],
        edges: [
          { from: "start", to: "create" },
          { from: "create", to: "done" },
        ],
      });

      const workIds = workingRunIds("wrk-check", 2);
      const rawAccept = await seedWorkingRun(db, workflow, {
        inputs: { query: "q", amount: 500 },
        nodeExecs: {
          create: async () => ({
            output: { invoice_number: "142", invoice_amount: 500, handoff: "ok" },
            usage: { tokens: 100, costUsd: 0.001, requestedModel: "claude-haiku-5-5", answeredModel: "claude-haiku-5-5" },
          }),
        },
      });
      db.prepare("UPDATE lane_pilot_wf_run SET id = ? WHERE id = ?").run(workIds[0]!, rawAccept);
      db.prepare("UPDATE lane_pilot_wf_step SET run_id = ? WHERE run_id = ?").run(workIds[0]!, rawAccept);
      addCase(db, { workflowId: "invoice-send", runId: workIds[0]!, verdict: "accept", graphVersion: 1 });

      const rawReject = await seedWorkingRun(db, workflow, {
        inputs: { query: "q", amount: 500 },
        nodeExecs: {
          create: async () => ({
            output: { invoice_number: "143", invoice_amount: 400, handoff: "ok" },
            usage: { tokens: 100, costUsd: 0.001, requestedModel: "claude-haiku-5-5", answeredModel: "claude-haiku-5-5" },
          }),
        },
      });
      db.prepare("UPDATE lane_pilot_wf_run SET id = ? WHERE id = ?").run(workIds[1]!, rawReject);
      db.prepare("UPDATE lane_pilot_wf_step SET run_id = ? WHERE run_id = ?").run(workIds[1]!, rawReject);
      addCase(db, { workflowId: "invoice-send", runId: workIds[1]!, verdict: "reject", graphVersion: 1 });
      recordOwnerRunVerdict(db, {
        runId: workIds[1]!,
        verdict: "reject",
        reason: "wrong_result",
        note: "invoice_amount mismatch",
      });

      const root = addRoad(db, {
        id: "dir:test",
        title: "Checks",
        kind: "direction",
        source: "lead",
        why: "Root direction",
      });
      const branchForGraph = addRoad(db, {
        parentId: root.id,
        title: "Require invoice_number",
        kind: "option",
        source: "lead",
        why: "Missing invoice_number on Elba create",
        class: "branch",
        payload: { graphId: "invoice-send", nodeId: "create", field: "invoice_number" },
      });
      const branchForNewGraph = addRoad(db, {
        parentId: root.id,
        title: "New graph candidate",
        kind: "option",
        source: "lead",
        why: "Should stay for architect path",
        class: "branch",
        payload: { key: "free:new-process" },
      });

      const proposed = await proposeHypotheses(
        {
          db,
          workflow,
          leadRoad: { listRoad, doneRoad },
          listRunVerdicts: (filter) => listRunVerdicts(db, filter),
        },
        { workflowId: "invoice-send", now: 50_000 },
      );

      expect(proposed).toHaveLength(2);
      expect(proposed.find((h) => h.source === "lead_road")).toMatchObject({
        nodeId: "create",
        armKind: "check",
        variant: { verify: "create.invoice_number != ''" },
      });
      expect(proposed.find((h) => h.source === "owner")).toMatchObject({
        nodeId: "create",
        armKind: "check",
        variant: { verify: "create.invoice_amount == $inputs.amount" },
      });

      // Consumed road row is marked done; new-graph row remains open.
      expect(getRoad(db, branchForGraph.id)?.state).toBe("done");
      expect(getRoad(db, branchForNewGraph.id)?.state).toBe("open");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("refuses variants with prompt key, skips non-allow-listed graphs, and never uses heldOutCaseIds", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const forbidden = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "create",
        armKind: "model",
        variant: { prompt: "You should do better" },
        graphVersion: 1,
        source: "census",
      });
      expect(forbidden).toEqual({ ok: false, reason: "variant_key_forbidden" });

      const warnLogs: string[] = [];
      const nonAllowed = await proposeHypotheses(
        {
          db,
          workflow: makeWf({ id: "other-graph" }),
          log: { warn: (m) => warnLogs.push(m) },
        },
        { workflowId: "other-graph" },
      );
      expect(nonAllowed).toEqual([]);
      expect(warnLogs).toContain("evolve propose skipped wf=other-graph: not allow-listed");

      // Disabled via evolve.enabled setting
      saveProjectSetting(db, "*", EVOLVE_ENABLED_KEY, false);
      const disabledLogs: string[] = [];
      const disabled = await proposeHypotheses(
        { db, workflow: makeWf({}), log: { warn: (m) => disabledLogs.push(m) } },
        { workflowId: "invoice-send" },
      );
      expect(disabled).toEqual([]);
      expect(disabledLogs).toContain("evolve propose skipped wf=invoice-send: disabled");

      // Allow-listing via evolve.graphs works
      saveProjectSetting(db, "*", EVOLVE_ENABLED_KEY, true);
      saveProjectSetting(db, "*", EVOLVE_GRAPHS_KEY, ["other-graph"]);
      const emptyCasesLogs: string[] = [];
      const noCases = await proposeHypotheses(
        { db, workflow: makeWf({ id: "other-graph" }), log: { warn: (m) => emptyCasesLogs.push(m) } },
        { workflowId: "other-graph" },
      );
      expect(noCases).toEqual([]);
      expect(emptyCasesLogs).toContain("evolve propose skipped wf=other-graph: no cases");

      // Guard: hypotheses.ts never calls or references heldOutCaseIds / heldOut.
      const src = readFileSync(join(process.cwd(), "src/rooms/evolve/server/services/hypotheses.ts"), "utf8");
      expect(src).not.toMatch(/heldOutCaseIds/);
      expect(src).not.toMatch(/heldOut/);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("ranks non-demotion proposals by costShare * stepCost descending and caps at activeCap", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const mkNode = (id: string) => ({
        id,
        type: "agent",
        role: "errand",
        provider: "claude-code",
        model: "claude-haiku-5-5",
        effect: "L",
        prompt: `Process ${id}`,
        out: [{ name: "out", type: "string" }],
      });
      const workflow = makeWf({
        nodes: [
          mkNode("n_low"),
          mkNode("n_high"),
          mkNode("n_mid"),
          mkNode("n_extra"),
          { id: "done", type: "action", action: "emit", map: { result: "n_high.out" } },
        ],
        edges: [
          { from: "start", to: "n_low" },
          { from: "n_low", to: "n_high" },
          { from: "n_high", to: "n_mid" },
          { from: "n_mid", to: "n_extra" },
          { from: "n_extra", to: "done" },
        ],
      });

      const workId = workingRunIds("wrk-rank", 1)[0]!;
      const rawId = await seedWorkingRun(db, workflow, {
        nodeExecs: {
          n_high: async () => ({
            output: { out: "ok", handoff: "ok" },
            usage: { tokens: 100, costUsd: 0.50, requestedModel: "claude-haiku-5-5", answeredModel: "claude-haiku-5-5" },
          }),
          n_mid: async () => ({
            output: { out: "ok", handoff: "ok" },
            usage: { tokens: 100, costUsd: 0.30, requestedModel: "claude-haiku-5-5", answeredModel: "claude-haiku-5-5" },
          }),
          n_low: async () => ({
            output: { out: "ok", handoff: "ok" },
            usage: { tokens: 100, costUsd: 0.15, requestedModel: "claude-haiku-5-5", answeredModel: "claude-haiku-5-5" },
          }),
          n_extra: async () => ({
            output: { out: "ok", handoff: "ok" },
            usage: { tokens: 100, costUsd: 0.05, requestedModel: "claude-haiku-5-5", answeredModel: "claude-haiku-5-5" },
          }),
        },
      });
      db.prepare("UPDATE lane_pilot_wf_run SET id = ? WHERE id = ?").run(workId, rawId);
      db.prepare("UPDATE lane_pilot_wf_step SET run_id = ? WHERE run_id = ?").run(workId, rawId);
      addCase(db, { workflowId: "invoice-send", runId: workId, verdict: "accept", graphVersion: 1 });

      const proposed = await proposeHypotheses(
        {
          db,
          workflow,
          generatePlan: async ({ nodeId }) => ({ steps: [`Step for ${nodeId}`] }),
        },
        { workflowId: "invoice-send" },
      );

      expect(proposed).toHaveLength(EVOLVE_THRESHOLDS.activeCap);
      expect(proposed.map((h) => h.nodeId)).toEqual(["n_high", "n_mid", "n_low"]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
