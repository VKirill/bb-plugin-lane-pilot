import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { EVOLVE_THRESHOLDS } from "@lane-pilot/contracts";
import { parseWorkflow, type NodeExecutor, type Workflow } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { scoreVerifier } from "../../src/rooms/checkers";
import { EVOLVE_REPLAY_MAX_RUNS_KEY } from "../../src/rooms/evolve";
import {
  addCase,
  getHypothesis,
  listNegatives,
  queueHypothesis,
  replayHypothesis,
  splitForRunId,
} from "../../src/rooms/evolve/server";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";

function heldOutRunIds(prefix: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count; i += 1) {
    const id = `${prefix}-h-${i}`;
    if (splitForRunId(id) === "held_out") out.push(id);
  }
  return out;
}

function makeReplayWorkflow(extra: Record<string, unknown> = {}): Workflow {
  return parseWorkflow({
    schemaVersion: 1,
    id: "invoice-send",
    name: { en: "Invoice Send", ru: "Отправка счёта" },
    description: { en: "Invoice workflow", ru: "Счёт" },
    inputs: [
      { name: "query", type: "string" },
      { name: "task_class", type: "string", required: false },
    ],
    outputs: [{ name: "result", type: "string" }],
    nodes: [
      {
        id: "draft",
        type: "agent",
        role: "analyst",
        effect: "R",
        provider: "claude-code",
        model: "claude-sonnet-5-5",
        verify: "draft.out != ''",
        prompt: "Draft {{input.query}}",
        out: [
          { name: "out", type: "string" },
          { name: "amount", type: "number" },
          { name: "artifact_path", type: "string" },
        ],
      },
      {
        id: "send",
        type: "action",
        action: "telegram.send_rich",
        effect: "L",
        out: [{ name: "message_id", type: "string" }],
      },
      {
        id: "done",
        type: "action",
        action: "emit",
        map: { result: "send.message_id" },
      },
    ],
    edges: [
      { from: "start", to: "draft" },
      { from: "draft", to: "send" },
      { from: "send", to: "done" },
    ],
    ...extra,
  });
}

function seedHeldOutRuns(
  db: ReturnType<typeof openDatabase>,
  wf: Workflow,
  opts: {
    prefix: string;
    count: number;
    draftOutputs?: (idx: number) => Record<string, unknown>;
    sendOutputs?: (idx: number) => Record<string, unknown>;
    extraSteps?: (runId: string, idx: number) => void;
    taskClass?: (idx: number) => string | undefined;
  },
): string[] {
  const runIds = heldOutRunIds(opts.prefix, opts.count);
  const defJson = JSON.stringify(wf);
  for (let i = 0; i < runIds.length; i += 1) {
    const runId = runIds[i]!;
    const tc = opts.taskClass?.(i);
    const inputs = { query: `case-${i}`, ...(tc ? { task_class: tc } : {}) };
    db.prepare(
      `INSERT INTO lane_pilot_wf_run
        (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, created_at, updated_at)
       VALUES (?, ?, ?, 'sha', ?, 'proj-1', 'succeeded', ?, ?, ?)`,
    ).run(runId, wf.id, wf.version, defJson, JSON.stringify(inputs), 1_000 + i, 1_100 + i);

    const draftOut = opts.draftOutputs?.(i) ?? {
      out: `draft-${i}`,
      amount: 100 + i,
      artifact_path: `/tmp/doc-${i}.pdf`,
    };
    const sendOut = opts.sendOutputs?.(i) ?? { message_id: `msg-${i}` };

    db.prepare(
      `INSERT INTO lane_pilot_wf_step
        (run_id, step_key, origin, node_id, visit, state, output_json, started_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'succeeded', ?, ?, ?)`,
    ).run(runId, "draft#1", "origin:draft#1", "draft", JSON.stringify(draftOut), 1_010 + i, 1_020 + i);

    db.prepare(
      `INSERT INTO lane_pilot_wf_step
        (run_id, step_key, origin, node_id, visit, state, output_json, started_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'succeeded', ?, ?, ?)`,
    ).run(runId, "send#1", "origin:send#1", "send", JSON.stringify(sendOut), 1_030 + i, 1_040 + i);

    opts.extraSteps?.(runId, i);

    addCase(db, {
      workflowId: wf.id,
      runId,
      verdict: "accept",
      ...(tc ? { taskClass: tc } : {}),
      graphVersion: wf.version,
      now: 2_000 + i,
    });
  }
  return runIds;
}

describe("Task 31: offline paired replay with outside evaluator", () => {
  it("passes a cheaper equal model arm with gain=cost and never executes L nodes", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const wf = makeReplayWorkflow();
      seedHeldOutRuns(db, wf, { prefix: "pass", count: 4 });

      const queued = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "draft",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: wf.version,
        source: "census",
      });
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;

      let clock = 10_000;
      const now = () => clock;
      const executedModels: string[] = [];
      let lNodeCalls = 0;

      const agentExecutor: NodeExecutor = {
        reentrant: true,
        run: async (ctx) => {
          const model = String((ctx.node as { model?: string }).model ?? "unknown");
          executedModels.push(model);
          clock += 100;
          const isCheaper = model === "claude-haiku-5-5";
          return {
            output: { out: "ok", amount: 150, artifact_path: "/tmp/out.pdf", handoff: "ok" },
            usage: {
              tokens: 500,
              costUsd: isCheaper ? 0.05 : 0.20,
              costState: "measured",
              requestedProvider: "claude-code",
              requestedModel: model,
              answeredProvider: "claude-code",
              answeredModel: model,
            },
          };
        },
      };

      const lNodeSpy: NodeExecutor = {
        reentrant: true,
        run: async () => {
          lNodeCalls += 1;
          return { output: { message_id: "should-never-run" } };
        },
      };

      const logs: string[] = [];
      const outcome = await replayHypothesis(
        {
          db,
          log: { info: (m) => logs.push(`INFO:${m}`), warn: (m) => logs.push(`WARN:${m}`) },
        },
        {
          workflow: wf,
          now,
          executors: {
            agent: agentExecutor,
            "telegram.send_rich": lNodeSpy,
          },
        },
        { hypothesisId: queued.hypothesis.id },
      );

      expect(outcome.pass).toBe(true);
      expect(outcome.reasons).toEqual([]);
      expect(outcome.comparison.verdict).toBe("pass");
      expect(outcome.comparison.nonInferior).toBe(true);
      expect(outcome.comparison.noRegressionByClass).toBe(true);
      expect(outcome.comparison.gain).toBe("cost");
      expect(outcome.scorecard.passK).toEqual({ a: 1, b: 1 });
      expect(outcome.scorecard.costs.baselinePerAcceptedUsd).toBeCloseTo(0.20, 6);
      expect(outcome.scorecard.costs.candidatePerAcceptedUsd).toBeCloseTo(0.05, 6);

      // L node must never execute; draft (R) ran 4 cases * 3 repeats * 3 arms = 36 times.
      expect(lNodeCalls).toBe(0);
      expect(executedModels).toHaveLength(36);
      expect(executedModels.filter((m) => m === "claude-sonnet-5-5")).toHaveLength(24);
      expect(executedModels.filter((m) => m === "claude-haiku-5-5")).toHaveLength(12);

      const stored = getHypothesis(db, queued.hypothesis.id);
      expect(stored?.state).toBe("replaying");
      expect(stored?.draftId).toBeTruthy();
      expect(stored?.scorecardJson).toBeTruthy();
      expect(listNegatives(db, "invoice-send")).toEqual([]);
      expect(logs).toContain(`INFO:evolve replay hyp=${queued.hypothesis.id} cases=4 k=3 pass=true gain=cost`);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("rejects a worse arm and archives it in the negative archive", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const wf = makeReplayWorkflow();
      seedHeldOutRuns(db, wf, { prefix: "worse", count: 4 });

      const queued = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "draft",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: wf.version,
        source: "census",
      });
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;

      let clock = 20_000;
      const outcome = await replayHypothesis(
        { db },
        {
          workflow: wf,
          now: () => clock,
          executors: {
            agent: {
              reentrant: true,
              run: async (ctx) => {
                clock += 100;
                const model = String((ctx.node as { model?: string }).model ?? "");
                const isCand = model === "claude-haiku-5-5";
                // Candidate produces empty `out`, failing mechanical verify (`draft.out != ''`).
                return {
                  output: { out: isCand ? "" : "ok", amount: 150, artifact_path: "/tmp/out.pdf", handoff: "ok" },
                  usage: {
                    tokens: 500,
                    costUsd: isCand ? 0.05 : 0.20,
                    costState: "measured",
                    requestedProvider: "claude-code",
                    requestedModel: model,
                    answeredProvider: "claude-code",
                    answeredModel: model,
                  },
                };
              },
            },
          },
        },
        { hypothesisId: queued.hypothesis.id },
      );

      expect(outcome.pass).toBe(false);
      expect(outcome.comparison.verdict).toBe("fail");
      expect(outcome.reasons.length).toBeGreaterThan(0);

      const stored = getHypothesis(db, queued.hypothesis.id);
      expect(stored?.state).toBe("rejected");
      expect(stored?.scorecardJson).toBeTruthy();

      const negatives = listNegatives(db, "invoice-send");
      expect(negatives).toHaveLength(1);
      expect(negatives[0]?.variantSignature).toBe(stored?.variantSignature);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("blocks a judge-only node when judgeTrusted is false (recorded as advisory) and passes when trusted", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const wf = makeReplayWorkflow({
        nodes: [
          {
            id: "draft",
            type: "agent",
            role: "analyst",
            effect: "R",
            provider: "claude-code",
            model: "claude-sonnet-5-5",
            // No mechanical verify -> judge-only node!
            prompt: "Draft {{input.query}}",
            out: [{ name: "out", type: "string" }],
          },
          {
            id: "send",
            type: "action",
            action: "telegram.send_rich",
            effect: "L",
            out: [{ name: "message_id", type: "string" }],
          },
          {
            id: "done",
            type: "action",
            action: "emit",
            map: { result: "send.message_id" },
          },
        ],
      });
      seedHeldOutRuns(db, wf, {
        prefix: "judge",
        count: 4,
        draftOutputs: (i) => ({ out: `accepted-text-${i}` }),
      });

      const hypUntrusted = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "draft",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: wf.version,
        source: "census",
      });
      expect(hypUntrusted.ok).toBe(true);
      if (!hypUntrusted.ok) return;

      let clock = 30_000;
      const agentExec: NodeExecutor = {
        reentrant: true,
        run: async (ctx) => {
          clock += 100;
          const model = String((ctx.node as { model?: string }).model ?? "");
          return {
            output: { out: "candidate-text", handoff: "ok" },
            usage: {
              tokens: 300,
              costUsd: model === "claude-haiku-5-5" ? 0.05 : 0.20,
              costState: "measured",
              requestedProvider: "claude-code",
              requestedModel: model,
              answeredProvider: "claude-code",
              answeredModel: model,
            },
          };
        },
      };

      const untrustedOutcome = await replayHypothesis(
        { db },
        {
          workflow: wf,
          now: () => clock,
          executors: { agent: agentExec },
          judge: { provider: "codex", model: "gpt-6.1-sol" },
          judgeTrusted: () => false,
          runPairwiseJudge: async ({ judge }) => ({
            outcome: "candidate_better",
            orders: ["candidate_better", "candidate_better"],
            judgeModel: judge.model,
          }),
        },
        { hypothesisId: hypUntrusted.hypothesis.id },
      );

      expect(untrustedOutcome.pass).toBe(false);
      expect(untrustedOutcome.reasons).toContain("judge_untrusted");
      expect(untrustedOutcome.scorecard.judgeTrusted).toBe(false);
      expect(untrustedOutcome.scorecard.judgeOutcomes.length).toBe(12);
      expect(untrustedOutcome.scorecard.judgeOutcomes.every((j) => j.advisory === true && j.trusted === false)).toBe(true);
      expect(getHypothesis(db, hypUntrusted.hypothesis.id)?.state).toBe("rejected");

      // Now clear negative for a new version / use a different reasoning variant with trusted judge -> passes!
      const hypTrusted = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "draft",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5", reasoning: "low" },
        graphVersion: wf.version,
        source: "census",
      });
      expect(hypTrusted.ok).toBe(true);
      if (!hypTrusted.ok) return;

      const trustedOutcome = await replayHypothesis(
        { db },
        {
          workflow: wf,
          now: () => clock,
          executors: { agent: agentExec },
          judge: { provider: "codex", model: "gpt-6.1-sol" },
          judgeTrusted: () => true,
          runPairwiseJudge: async ({ judge }) => ({
            outcome: "tie",
            orders: ["tie", "tie"],
            judgeModel: judge.model,
          }),
        },
        { hypothesisId: hypTrusted.hypothesis.id },
      );

      expect(trustedOutcome.pass).toBe(true);
      expect(trustedOutcome.scorecard.judgeTrusted).toBe(true);
      expect(trustedOutcome.scorecard.judgeOutcomes.every((j) => j.advisory === false && j.trusted === true)).toBe(true);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("rejects a critic replacement whose scoreVerifier catchRate is 0.8 (< checkerCatch 0.9)", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const wf = makeReplayWorkflow({
        nodes: [
          {
            id: "draft",
            type: "agent",
            role: "analyst",
            effect: "L",
            prompt: "Draft",
            out: [
              { name: "id", type: "number" },
              { name: "status", type: "string" },
              { name: "amount", type: "number" },
              { name: "artifact_path", type: "string" },
            ],
          },
          {
            id: "critic",
            type: "agent",
            role: "code-critic",
            effect: "R",
            provider: "claude-code",
            model: "claude-opus-5-5",
            allow_same_model: true,
            same_model_reason: "test",
            verify: "critic.ok == true",
            prompt: "Verify {{draft.artifact_path}}",
            out: [{ name: "ok", type: "boolean" }],
          },
          {
            id: "done",
            type: "action",
            action: "emit",
            map: { result: "draft.status" },
          },
        ],
        edges: [
          { from: "start", to: "draft" },
          { from: "draft", to: "critic" },
          { from: "critic", to: "done" },
        ],
      });

      seedHeldOutRuns(db, wf, {
        prefix: "critic",
        count: 4,
        draftOutputs: (i) => ({
          id: i + 1,
          status: "done",
          amount: 100 + i,
          artifact_path: `/tmp/doc-${i + 1}.pdf`,
        }),
        extraSteps: (runId, i) => {
          db.prepare(
            `INSERT INTO lane_pilot_wf_step
              (run_id, step_key, origin, node_id, visit, state, output_json, started_at, updated_at)
             VALUES (?, 'critic#1', 'origin:critic#1', 'critic', 1, 'succeeded', '{"ok":true}', ?, ?)`,
          ).run(runId, 1_025 + i, 1_028 + i);
        },
      });

      const queued = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "critic",
        armKind: "model",
        variant: { provider: "codex", model: "gpt-6.1-terra" },
        graphVersion: wf.version,
        source: "census",
      });
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;

      const tenCases = Array.from({ length: 10 }, (_, idx) => ({
        output: {
          id: idx + 1,
          status: "done",
          amount: 100 + idx,
          artifact_path: `/tmp/doc-${idx + 1}.pdf`,
        },
        kinds: ["drop_required_field"] as const,
      }));
      const eightyPercentVerifier = (out: Record<string, unknown>) => {
        if ((out.id === 9 || out.id === 10) && out.amount === undefined) return true;
        return (
          typeof out.id === "number" &&
          out.status === "done" &&
          typeof out.amount === "number" &&
          typeof out.artifact_path === "string" &&
          out.artifact_path.length > 0
        );
      };

      let clock = 40_000;
      const outcome = await replayHypothesis(
        { db },
        {
          workflow: wf,
          now: () => clock,
          executors: {
            agent: {
              reentrant: true,
              run: async (ctx) => {
                clock += 100;
                const model = String((ctx.node as { model?: string }).model ?? "");
                return {
                  output: { ok: true, handoff: "ok" },
                  usage: {
                    tokens: 200,
                    costUsd: model === "gpt-6.1-terra" ? 0.02 : 0.15,
                    costState: "measured",
                    requestedProvider: "codex",
                    requestedModel: model,
                    answeredProvider: "codex",
                    answeredModel: model,
                  },
                };
              },
            },
          },
          scoreVerifier,
          verifierFn: eightyPercentVerifier,
          verifierCases: tenCases.map((c) => ({ output: c.output, kinds: [...c.kinds] })),
          verifierOptions: { requiredFields: ["amount"] },
        },
        { hypothesisId: queued.hypothesis.id },
      );

      expect(outcome.pass).toBe(false);
      expect(outcome.reasons).toContain("checker_catch:0.8");
      expect(outcome.scorecard.verifierScore?.catchRate).toBe(0.8);
      expect(outcome.scorecard.verifierScore?.bar).toBe(EVOLVE_THRESHOLDS.checkerCatch);
      expect(getHypothesis(db, queued.hypothesis.id)?.state).toBe("rejected");
      expect(listNegatives(db, "invoice-send")).toHaveLength(1);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("aborts without archiving to negatives on budget refusal, no cases, or runner error", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    try {
      const wf = makeReplayWorkflow();

      // 1. No cases -> aborted with replay_error, not added to negatives.
      const hypNoCases = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "draft",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: wf.version,
        source: "census",
      });
      expect(hypNoCases.ok).toBe(true);
      if (!hypNoCases.ok) return;

      const warnLogs: string[] = [];
      const noCasesRes = await replayHypothesis(
        { db, log: { warn: (m) => warnLogs.push(m) } },
        { workflow: wf },
        { hypothesisId: hypNoCases.hypothesis.id },
      );
      expect(noCasesRes.pass).toBe(false);
      expect(noCasesRes.scorecard.aborted).toBe(true);
      expect(getHypothesis(db, hypNoCases.hypothesis.id)?.state).toBe("rejected");
      expect(getHypothesis(db, hypNoCases.hypothesis.id)?.reason).toBe("replay_error");
      expect(listNegatives(db, "invoice-send")).toEqual([]);
      expect(warnLogs.some((m) => m.includes(`evolve replay aborted hyp=${hypNoCases.hypothesis.id}: no_cases`))).toBe(true);

      // 2. Budget exceeded (3 cases * 3 repeats * 3 arms = 27 > evolve.replay_max_runs=15).
      seedHeldOutRuns(db, wf, { prefix: "budget", count: 3 });
      saveProjectSetting(db, "*", EVOLVE_REPLAY_MAX_RUNS_KEY, 15);
      const hypBudget = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "draft",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: wf.version,
        source: "census",
      });
      expect(hypBudget.ok).toBe(true);
      if (!hypBudget.ok) return;

      let runnerCalls = 0;
      const budgetRes = await replayHypothesis(
        { db, log: { warn: (m) => warnLogs.push(m) } },
        {
          workflow: wf,
          runDraftTest: async (...args) => {
            runnerCalls += 1;
            throw new Error(`should not run ${args.length}`);
          },
        },
        { hypothesisId: hypBudget.hypothesis.id },
      );
      expect(budgetRes.pass).toBe(false);
      expect(budgetRes.scorecard.aborted).toBe(true);
      expect(runnerCalls).toBe(0);
      expect(getHypothesis(db, hypBudget.hypothesis.id)?.state).toBe("rejected");
      expect(getHypothesis(db, hypBudget.hypothesis.id)?.reason).toBe("replay_error");
      expect(listNegatives(db, "invoice-send")).toEqual([]);
      expect(warnLogs.some((m) => m.includes(`evolve replay aborted hyp=${hypBudget.hypothesis.id}: budget_exceeded`))).toBe(true);

      // 3. Runner error -> aborted with replay_error, not added to negatives.
      saveProjectSetting(db, "*", EVOLVE_REPLAY_MAX_RUNS_KEY, 120);
      const hypErr = queueHypothesis(db, {
        workflowId: "invoice-send",
        nodeId: "draft",
        armKind: "model",
        variant: { provider: "claude-code", model: "claude-haiku-5-5" },
        graphVersion: wf.version,
        source: "census",
      });
      expect(hypErr.ok).toBe(true);
      if (!hypErr.ok) return;

      const errRes = await replayHypothesis(
        { db, log: { warn: (m) => warnLogs.push(m) } },
        {
          workflow: wf,
          runDraftTest: async () => {
            throw new Error("runner crashed");
          },
        },
        { hypothesisId: hypErr.hypothesis.id },
      );
      expect(errRes.pass).toBe(false);
      expect(errRes.scorecard.aborted).toBe(true);
      expect(getHypothesis(db, hypErr.hypothesis.id)?.state).toBe("rejected");
      expect(getHypothesis(db, hypErr.hypothesis.id)?.reason).toBe("replay_error");
      expect(listNegatives(db, "invoice-send")).toEqual([]);
      expect(warnLogs.some((m) => m.includes(`evolve replay aborted hyp=${hypErr.hypothesis.id}: runner_error: runner crashed`))).toBe(true);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
