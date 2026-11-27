import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_FACT_FIELDS, factVerdictFromCheck } from "@lane-pilot/contracts";
import { costUsd } from "@lane-pilot/models";
import { parseWorkflow, nodeCensus, stepFactVerdict } from "@lane-pilot/workflow-engine";
import { readCheckRun } from "../../src/rooms/tasks/server";
import { threadUsage } from "../../src/rooms/usage/server";
import { spentBy } from "../../src/rooms/workflow/server/services/workflow-agent-facts";
import { engineOn, journalDb, ok, rows, wf } from "./engine-helpers";

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/test-runner-output");
const readFixture = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");

describe("Task 26: per-step run facts & node census", () => {
  it("exports shared step-fact field names from contracts", () => {
    expect(STEP_FACT_FIELDS).toEqual(expect.arrayContaining([
      "run_id",
      "requested_provider",
      "requested_model",
      "answered_provider",
      "answered_model",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cost_micro_usd",
      "cost_state",
      "duration_ms",
      "verdict",
      "failure_class",
      "rework_visits",
      "graph_version",
      "request_id",
      "attempt_id",
      "session_id",
    ]));
  });

  it("records requested vs answered model/provider separately and logs WARN + DEBUG", async () => {
    const db = journalDb();
    let clock = 10_000;
    const debugLogs: string[] = [];
    const warnLogs: string[] = [];
    const definition = wf({
      version: 3,
      nodes: [
        { id: "work", type: "agent", role: "analyst", prompt: "Analyze {{input.query}}", output: [{ name: "summary", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "work.summary" } },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "done" },
      ],
    });
    const engine = engineOn(
      db,
      {
        agent: {
          run: async () => {
            clock += 250;
            return {
              output: { summary: "done", handoff: "done" },
              threadId: "thr-ans-1",
              usage: {
                tokens: 1_500,
                costUsd: 0.01,
                inputTokens: 1_000,
                outputTokens: 500,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                requestedProvider: "anthropic",
                requestedModel: "claude-opus-5-5",
                answeredProvider: "openai",
                answeredModel: "gpt-6.1-sol",
                costState: "measured",
                requestId: "req-42",
                sessionId: "thr-ans-1",
              },
            };
          },
        },
      },
      {
        now: () => clock,
        logger: {
          debug: (msg) => debugLogs.push(msg),
          warn: (msg) => warnLogs.push(msg),
        },
      },
    );

    const started = engine.start({ workflow: definition, inputs: { query: "hi" }, link: { attemptId: "att-7" } });
    const summary = await started.done;
    expect(summary.status).toBe("succeeded");

    const stepRow = rows(db, "SELECT * FROM lane_pilot_wf_step WHERE run_id=? AND node_id='work'", summary.runId)[0]!;
    expect(stepRow).toMatchObject({
      run_id: summary.runId,
      requested_provider: "anthropic",
      requested_model: "claude-opus-5-5",
      answered_provider: "openai",
      answered_model: "gpt-6.1-sol",
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_state: "measured",
      duration_ms: 250,
      verdict: "pass",
      failure_class: null,
      rework_visits: 0,
      graph_version: 3,
      request_id: "req-42",
      attempt_id: "att-7",
      session_id: "thr-ans-1",
    });
    const expectedMicro = Math.round((costUsd("gpt-6.1-sol", { uncached: 1_000, cacheRead: 0, cacheWrite: 0, output: 500 }) ?? 0) * 1_000_000);
    expect(stepRow.cost_micro_usd).toBe(expectedMicro);

    expect(debugLogs.some((line) => line.includes("wf.step_fact") && line.includes("node=work"))).toBe(true);
    expect(warnLogs.some((line) => line.includes("model_mismatch") && line.includes("claude-opus-5-5") && line.includes("gpt-6.1-sol"))).toBe(true);
    expect(warnLogs.some((line) => line.includes("cost_not_measured"))).toBe(false);
  });

  it("stores not_measured and null (never 0) and warns on unknown usage or unpriced model for an agent call", async () => {
    const db = journalDb();
    let clock = 1_000;
    const warnLogs: string[] = [];
    const definition = wf({
      nodes: [
        { id: "acp", type: "agent", role: "analyst", prompt: "Check", output: [{ name: "a", type: "string" }] },
        { id: "custom", type: "agent", role: "writer", prompt: "Write", output: [{ name: "b", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "custom.b" } },
      ],
      edges: [
        { from: "start", to: "acp" },
        { from: "acp", to: "custom" },
        { from: "custom", to: "done" },
      ],
    });
    const engine = engineOn(
      db,
      {
        agent: {
          run: async (ctx) => {
            if (ctx.nodeId === "acp") {
              clock += 100;
              return {
                output: { a: "ok", handoff: "acp" },
                threadId: "thr-acp",
                usage: {
                  tokens: 0,
                  costUsd: 0,
                  unknown: true,
                  requestedProvider: "acp-cursor",
                  requestedModel: "cursor-default",
                  answeredProvider: "acp-cursor",
                  answeredModel: "cursor-default",
                  costState: "not_measured",
                },
              };
            }
            clock += 120;
            return {
              output: { b: "ok", handoff: "custom" },
              threadId: "thr-custom",
              usage: {
                tokens: 800,
                costUsd: 9.99, // even if an executor passes a fallback number, unpriced model MUST be null + not_measured
                inputTokens: 600,
                outputTokens: 200,
                requestedProvider: "local",
                requestedModel: "unpriced-local-v1",
                answeredProvider: "local",
                answeredModel: "unpriced-local-v1",
              },
            };
          },
        },
      },
      {
        now: () => clock,
        logger: { warn: (msg) => warnLogs.push(msg) },
      },
    );

    const summary = await engine.start({ workflow: definition, inputs: { query: "hi" } }).done;
    expect(summary.status).toBe("succeeded");

    const acpRow = rows(db, "SELECT cost_micro_usd, cost_state FROM lane_pilot_wf_step WHERE run_id=? AND node_id='acp'", summary.runId)[0]!;
    expect(acpRow).toEqual({ cost_micro_usd: null, cost_state: "not_measured" });

    const customRow = rows(db, "SELECT cost_micro_usd, cost_state, input_tokens, output_tokens FROM lane_pilot_wf_step WHERE run_id=? AND node_id='custom'", summary.runId)[0]!;
    expect(customRow).toEqual({ cost_micro_usd: null, cost_state: "not_measured", input_tokens: 600, output_tokens: 200 });

    const doneRow = rows(db, "SELECT cost_micro_usd, cost_state FROM lane_pilot_wf_step WHERE run_id=? AND node_id='done'", summary.runId)[0]!;
    expect(doneRow).toEqual({ cost_micro_usd: 0, cost_state: "measured" });

    expect(warnLogs.filter((line) => line.includes("cost_not_measured"))).toHaveLength(2);
  });

  it("never counts cache_read_tokens as input_tokens through threadUsage + spentBy + engine", async () => {
    const events = [
      { seq: 1, createdAt: 1_000, type: "client/turn/requested", data: { execution: { providerId: "anthropic", model: "claude-opus-5-5" } } },
      { seq: 2, createdAt: 1_001, type: "provider/modelFallback", data: { originalProvider: "anthropic", originalModel: "claude-opus-5-5", fallbackModel: "claude-sonnet-5-5", execution: { providerId: "anthropic", model: "claude-sonnet-5-5" } } },
      {
        seq: 3,
        createdAt: 1_002,
        type: "thread/tokenUsage/updated",
        data: {
          turnId: "turn-99",
          tokenUsage: {
            last: { inputTokens: 1_200, cachedInputTokens: 4_300, cacheReadInputTokens: 4_000, cacheWriteInputTokens: 300, outputTokens: 250, totalTokens: 5_750 },
            total: { inputTokens: 1_200, cachedInputTokens: 4_300, cacheReadInputTokens: 4_000, cacheWriteInputTokens: 300, outputTokens: 250, totalTokens: 5_750 },
          },
        },
      },
    ];
    const fakeBb = {
      log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
      sdk: { threads: { events: { list: async ({ afterSeq }: { afterSeq?: string }) => (afterSeq ? [] : events) } } },
    } as never;

    const tu = await threadUsage(fakeBb, "thr-cache-1", { fallbackModel: "claude-opus-5-5", fallbackProvider: "anthropic" });
    expect(tu.known).toBe(true);
    expect(tu.inputTokens).toBe(1_200);
    expect(tu.cacheReadTokens).toBe(4_000);
    expect(tu.cacheWriteTokens).toBe(300);
    expect(tu.outputTokens).toBe(250);
    expect(tu.requestedModel).toBe("claude-opus-5-5");
    expect(tu.answeredModel).toBe("claude-sonnet-5-5");
    expect(tu.costState).toBe("measured");
    expect(tu.requestId).toBe("turn-99");

    const usage = await spentBy(fakeBb, [{ id: "thr-cache-1", model: "claude-opus-5-5", provider: "anthropic" }], {
      requestedProvider: "anthropic",
      requestedModel: "claude-opus-5-5",
    });

    const db = journalDb();
    const definition = wf({
      nodes: [
        { id: "worker", type: "agent", role: "analyst", prompt: "Check", output: [{ name: "out", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "worker.out" } },
      ],
      edges: [{ from: "start", to: "worker" }, { from: "worker", to: "done" }],
    });
    const engine = engineOn(db, {
      agent: { run: async () => ({ output: { out: "ok", handoff: "done" }, threadId: "thr-cache-1", usage }) },
    });
    const summary = await engine.start({ workflow: definition, inputs: { query: "cache" } }).done;
    expect(summary.status).toBe("succeeded");

    const row = rows(db, "SELECT * FROM lane_pilot_wf_step WHERE run_id=? AND node_id='worker'", summary.runId)[0]!;
    expect(row.input_tokens).toBe(1_200);
    expect(row.cache_read_tokens).toBe(4_000);
    expect(row.cache_write_tokens).toBe(300);
    expect(row.output_tokens).toBe(250);
    expect(row.requested_model).toBe("claude-opus-5-5");
    expect(row.answered_model).toBe("claude-sonnet-5-5");
    expect(row.session_id).toBe("thr-cache-1");
    expect(row.request_id).toBe("turn-99");
    const expectedMicro = Math.round((costUsd("claude-sonnet-5-5", { uncached: 1_200, cacheRead: 4_000, cacheWrite: 300, output: 250 }) ?? 0) * 1_000_000);
    expect(row.cost_micro_usd).toBe(expectedMicro);
  });

  it("maps test-runner fixtures and skipped checks to the exact fact verdict and failure_class", async () => {
    // 1. Zero tests (node --test)
    expect(factVerdictFromCheck(readCheckRun({ exitCode: 0, stdout: readFixture("node-isolation-none-filter.txt") }, { command: "node --test" }).verdict))
      .toEqual({ verdict: "not_run", failureClass: null });
    // 2. Skipped-only runs (node, vitest)
    for (const fixture of ["node-skipped-only.txt", "vitest-filter-none.txt", "vitest-two-files-none.txt"]) {
      const check = readCheckRun({ exitCode: 0, stdout: readFixture(fixture) }, { command: "npx vitest run" });
      expect(check.verdict).toBe("not_run");
      expect(factVerdictFromCheck(check.verdict)).toEqual({ verdict: "not_run", failureClass: null });
    }
    // 3. passWithNoTests
    expect(factVerdictFromCheck(readCheckRun({ exitCode: 0, stdout: readFixture("vitest-nofiles-pass.txt") }, { command: "npx vitest run --passWithNoTests" }).verdict))
      .toEqual({ verdict: "not_run", failureClass: null });
    // 4. Unhandled error block
    expect(factVerdictFromCheck(readCheckRun({ exitCode: 1, stdout: readFixture("vitest-unhandled.txt") }, { command: "npx vitest run" }).verdict))
      .toEqual({ verdict: "fail", failureClass: "product_fail" });
    // 5. Environment error & pass
    expect(factVerdictFromCheck("environment_error")).toEqual({ verdict: "fail", failureClass: "environment_error" });
    expect(factVerdictFromCheck("pass")).toEqual({ verdict: "pass", failureClass: null });

    // Direct stepFactVerdict check for skipped step & CheckVerdict payload in workflow engine
    expect(stepFactVerdict({ state: "skipped" })).toEqual({ verdict: "not_run", failureClass: null });

    const db = journalDb();
    const definition = wf({
      nodes: [
        { id: "run_check", type: "action", action: "check", skip_when: "$mode == 'quick'", skip_out: { verdict: "not_run" }, output: [{ name: "verdict", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "run_check.verdict" } },
      ],
      edges: [{ from: "start", to: "run_check" }, { from: "run_check", to: "done" }],
    });
    const engine = engineOn(db, { check: ok(() => ({ verdict: "pass" })) });
    const summary = await engine.start({ workflow: definition, inputs: { query: "skip-check" }, mode: "quick" }).done;
    expect(summary.status).toBe("succeeded");

    const skippedRow = rows(db, "SELECT state, verdict, failure_class, cost_micro_usd, cost_state FROM lane_pilot_wf_step WHERE run_id=? AND node_id='run_check'", summary.runId)[0]!;
    expect(skippedRow).toEqual({
      state: "skipped",
      verdict: "not_run",
      failure_class: null,
      cost_micro_usd: 0,
      cost_state: "measured",
    });
  });

  it("tracks rework_visits on loop revisits and classifies code vs stable_agent vs open_agent in nodeCensus", async () => {
    const db = journalDb();
    let loopCount = 0;
    const definition = parseWorkflow({
      schemaVersion: 1,
      id: "census-wf",
      name: "Census WF",
      description: { en: "Census test", ru: "Тест переписи" },
      inputs: [{ name: "topic", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      nodes: [
        { id: "prep", type: "action", action: "prep", output: [{ name: "ready", type: "boolean" }] },
        { id: "stable_classify", type: "agent", role: "analyst", prompt: "Classify {{input.topic}}", output: [{ name: "label", type: "string" }] },
        { id: "open_explore", type: "agent", role: "analyst", maxVisits: 3, prompt: "Explore {{input.topic}}", output: [{ name: "notes", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "open_explore.notes" } },
      ],
      edges: [
        { from: "start", to: "prep" },
        { from: "prep", to: "stable_classify", with: { topic: "input.topic" } },
        { from: "stable_classify", to: "open_explore", with: { label: "stable_classify.label" } },
        { from: "open_explore", to: "open_explore", when: "open_explore.notes == 'retry'" },
        { from: "open_explore", to: "done", when: "open_explore.notes != 'retry'" },
      ],
    });
    let stepKind: "stable" | "open" = "stable";
    const engine = engineOn(db, {
      prep: ok(() => ({ ready: true })),
      agent: {
        run: async (ctx) => {
          if (ctx.nodeId === "stable_classify") {
            stepKind = "stable";
            return {
              output: { label: "bug", handoff: "classified" },
              threadId: `thr-stable-${ctx.runId}`,
              usage: {
                tokens: 1_000,
                costUsd: 0.01,
                inputTokens: 800,
                outputTokens: 200,
                requestedProvider: "openai",
                requestedModel: "gpt-6.1-sol",
                answeredProvider: "openai",
                answeredModel: "gpt-6.1-sol",
              },
            };
          }
          stepKind = "open";
          loopCount += 1;
          return {
            output: { notes: loopCount === 1 ? "retry" : `explored-${stepKind}`, handoff: "explored" },
            threadId: `thr-open-${ctx.runId}-${loopCount}`,
            usage: {
              tokens: 2_000,
              costUsd: 0.02,
              inputTokens: 1_500,
              outputTokens: 500,
              requestedProvider: "openai",
              requestedModel: "gpt-6.1-sol",
              answeredProvider: "openai",
              answeredModel: "gpt-6.1-sol",
            },
          };
        },
      },
    });

    const run1 = await engine.start({ workflow: definition, inputs: { topic: "a" } }).done;
    expect(run1.status).toBe("succeeded");

    const openSteps = rows(db, "SELECT step_key, visit, rework_visits FROM lane_pilot_wf_step WHERE run_id=? AND node_id='open_explore' ORDER BY visit", run1.runId);
    expect(openSteps).toEqual([
      { step_key: "open_explore#1", visit: 1, rework_visits: 0 },
      { step_key: "open_explore#2", visit: 2, rework_visits: 1 },
    ]);

    const census = nodeCensus(db, { workflowId: "census-wf" });
    const byNode = Object.fromEntries(census.map((entry) => [entry.nodeId, entry]));
    expect(byNode.prep).toMatchObject({ nodeKind: "action", classification: "code", formArmCandidate: false });
    expect(byNode.done).toMatchObject({ nodeKind: "action", classification: "code", formArmCandidate: false });
    expect(byNode.stable_classify).toMatchObject({
      nodeKind: "agent",
      classification: "stable_agent",
      formArmCandidate: true,
      steps: 1,
      totalReworkVisits: 0,
    });
    expect(byNode.open_explore).toMatchObject({
      nodeKind: "agent",
      classification: "open_agent",
      formArmCandidate: false,
      steps: 2,
      totalReworkVisits: 1,
    });
    const shareSum = census.reduce((sum, entry) => sum + entry.costShare, 0);
    expect(shareSum).toBeCloseTo(1, 5);
    expect(byNode.stable_classify!.costShare).toBeGreaterThan(0);
    expect(byNode.open_explore!.costShare).toBeGreaterThan(byNode.stable_classify!.costShare);
  });
});
