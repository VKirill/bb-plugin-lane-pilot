import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import {
  evaluateModelRouting,
  latestModelRebenchSummary,
  modelRebenchMorningLine,
  mountModelRebenchGraph,
  saveModelRebenchResult,
  MODEL_REBENCH_WORKFLOW,
  type ModelRebenchMetrics,
} from "../../src/rooms/night-graphs";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";

function seedReceiptsAndAttempts(db: any) {
  db.exec("PRAGMA foreign_keys = OFF");
  const now = Date.now();
  // Attempt 1: accepted with gpt-5.4-mini
  db.prepare(`
    INSERT INTO lane_pilot_attempt (id, run_id, task_id, state, reason, created_at, updated_at)
    VALUES ('att_1', 'run_1', 'task_1', 'accepted', NULL, ?, ?)
  `).run(now - 1000, now - 500);

  db.prepare(`
    INSERT INTO lane_pilot_jev_receipt (
      judgment, version, mode, project_id, run_id, subject,
      input_sha256, input_chars, questions, status, decision, decided_by, at
    ) VALUES (
      'writer.model', 1, 'active', 'proj_1', 'run_1', 'task_1',
      'sha1', 100, 1, 'ok', '{"key":"gpt-5.4-mini"}', 'jev', ?
    )
  `).run(now - 1000);

  // Attempt 2: failed with claude-haiku-4-5
  db.prepare(`
    INSERT INTO lane_pilot_attempt (id, run_id, task_id, state, reason, created_at, updated_at)
    VALUES ('att_2', 'run_1', 'task_2', 'validation_failed', 'test failed', ?, ?)
  `).run(now - 800, now - 400);

  db.prepare(`
    INSERT INTO lane_pilot_jev_receipt (
      judgment, version, mode, project_id, run_id, subject,
      input_sha256, input_chars, questions, status, decision, decided_by, at
    ) VALUES (
      'writer.model', 1, 'active', 'proj_1', 'run_1', 'task_2',
      'sha2', 100, 1, 'ok', '{"key":"claude-haiku-4-5"}', 'jev', ?
    )
  `).run(now - 800);

  // Receipt 3: route.workflow with outcome agree
  db.prepare(`
    INSERT INTO lane_pilot_jev_receipt (
      judgment, version, mode, project_id, run_id, subject,
      input_sha256, input_chars, questions, status, decision, decided_by, outcome, at
    ) VALUES (
      'route.workflow', 1, 'active', 'proj_1', 'run_1', 'route',
      'sha3', 100, 1, 'ok', '{"choice":"quality-loop"}', 'jev', 'agree:same', ?
    )
  `).run(now - 600);
}

describe("monthly model routing re-bench (Item 2)", () => {
  it("evaluateModelRouting computes accurate accuracy, winRate, and per-model breakdown", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    seedReceiptsAndAttempts(db);

    const metrics = evaluateModelRouting(db);
    expect(metrics.evaluatedDecisions).toBe(3);
    // 2 agreed: task_1 accepted + route.workflow agree
    expect(metrics.agreedOutcomes).toBe(2);
    expect(metrics.accuracy).toBeCloseTo(2 / 3);
    // 2 attempts total: 1 accepted -> 50%
    expect(metrics.winRate).toBe(0.5);

    expect(metrics.byModel["gpt-5.4-mini"]?.accepted).toBe(1);
    expect(metrics.byModel["claude-haiku-4-5"]?.accepted).toBe(0);
    expect(metrics.recommendations.length).toBeGreaterThan(0);
  });

  it("saves rebench result and generates Russian morning summary", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const now = Date.now();

    const sampleMetrics: ModelRebenchMetrics = {
      month: "2026-10",
      evaluatedDecisions: 10,
      agreedOutcomes: 8,
      accuracy: 0.8,
      winRate: 0.85,
      byModel: {},
      recommendations: ["Keep current routing"],
    };

    saveModelRebenchResult(db, "run_rebench_1", "proj_1", sampleMetrics, now);

    const summary = latestModelRebenchSummary(db, now - 1000, now + 1000);
    expect(summary).not.toBeNull();
    expect(summary!.evaluated).toBe(10);
    expect(summary!.accuracy).toBe(0.8);
    expect(summary!.winRate).toBe(0.85);

    const line = modelRebenchMorningLine(db, now);
    expect(line).toContain("Месячный бенч маршрутизации моделей: оценено 10 решений Jev (точность 80%, успешность выбранных моделей 85%).");
  });

  it("mountModelRebenchGraph registers workflow executors and runs graph steps", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    seedReceiptsAndAttempts(db);

    const engine = new WorkflowEngine({ db, harnessVersion: "0.1.268" });
    const services = { workflowEngine: engine } as any;
    const ctx = { bb, db, log: () => {}, isDisposed: () => false } as any;

    mountModelRebenchGraph(ctx, services);

    expect(engine.hasExecutor("lp.model_rebench_eval")).toBe(true);
    expect(engine.hasExecutor("lp.model_rebench_report")).toBe(true);

    const evalExec = (engine as any).executors.get("lp.model_rebench_eval");
    const evalRes = await evalExec.run({
      node: { id: "eval", type: "action", action: "lp.model_rebench_eval" },
      inputs: {},
      input: { with: {}, via: { mode: "artifact" } },
      resolve: () => undefined,
      runtime: { projectId: "proj_1" },
      runId: "r_test",
      stepKey: "eval#1",
    });

    expect(evalRes.output.status).toBe("evaluated");
    expect(evalRes.output.evaluated_count).toBe(3);

    const reportExec = (engine as any).executors.get("lp.model_rebench_report");
    const reportRes = await reportExec.run({
      node: { id: "report", type: "action", action: "lp.model_rebench_report" },
      inputs: {},
      input: { with: {}, via: { mode: "artifact" } },
      resolve: (ref: string) => (ref === "eval.report" ? evalRes.output.report : undefined),
      runtime: { projectId: "proj_1" },
      runId: "r_test",
      stepKey: "report#1",
    });

    expect(reportRes.output.status).toBe("done");
    expect(reportRes.output.summary).toContain("Model rebench");
  });
});
