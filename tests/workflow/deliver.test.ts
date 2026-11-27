import { loadWorkflow, runDraftTest, testCasesOf, type GraphNode } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { chainStore } from "./chain-harness";
import { journalDb, rows } from "./engine-helpers";

/**
 * Task 21: `invoice-send` `create` step on rails (`form: "plan"`, `fallback: "agent"`, `verify`, `effect: "L"`).
 */
describe("invoice-send create on rails", () => {
  it("declares form=plan, fallback=agent, effect=L, <=10 plan steps, and passes budget/rail validation", async () => {
    const store = await chainStore();
    const wf = store.get("invoice-send")!.workflow;
    const loaded = loadWorkflow(wf, { resolve: store.resolve, shipped: true });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const codes = loaded.warnings.map((w) => w.code);
      expect(codes).not.toContain("plan_over_budget");
      expect(codes).not.toContain("prompt_over_budget");
    }

    const create = wf.nodes.find((n) => n.id === "create") as Extract<GraphNode, { type: "agent" }>;
    expect(create.effect).toBe("L");
    expect(create.form).toBe("plan");
    expect(create.fallback).toBe("agent");
    expect(create.prompt).toContain("kontur-elba");
    expect(typeof create.plan).toBe("object");
    if (create.plan && typeof create.plan === "object") {
      expect(create.plan.steps?.length).toBeGreaterThan(0);
      expect(create.plan.steps?.length).toBeLessThanOrEqual(10);
    }
    expect(create.verify).toBeDefined();
  });

  it("runs all invoice-send test cases: plan pass records form_used=plan and wrong amount falls back plan->agent", async () => {
    const store = await chainStore();
    const wf = store.get("invoice-send")!.workflow;
    const cases = testCasesOf(wf);
    const db = journalDb();

    const passCase = cases.find((tc) => tc.id === "invoice-1/plan_pass");
    const fallbackCase = cases.find((tc) => tc.id === "invoice-1/plan_fallback_wrong_amount");
    expect(passCase).toBeDefined();
    expect(fallbackCase).toBeDefined();

    for (const tc of cases) {
      const res = await runDraftTest({ db, harnessVersion: "test", resolveWorkflow: store.resolve }, wf, tc);
      expect(res.green, `${tc.id}: ${res.failures.join("; ")}`).toBe(true);
      expect(res.status).toBe("succeeded");

      const stepRow = rows<{ form_used: string | null; fallback_taken: string | null; verdict: string | null }>(
        db,
        "SELECT form_used, fallback_taken, verdict FROM lane_pilot_wf_step WHERE run_id=? AND node_id='create'",
        res.runId!,
      )[0];
      expect(stepRow).toBeDefined();
      if (tc.id === "invoice-1/plan_fallback_wrong_amount") {
        expect(stepRow).toEqual({
          form_used: "agent",
          fallback_taken: "plan->agent",
          verdict: "pass",
        });
      } else {
        expect(stepRow).toEqual({
          form_used: "plan",
          fallback_taken: null,
          verdict: "pass",
        });
      }
    }
  });

  it("fails verify and falls back plan->agent on wrong amount, wrong inn, or empty invoice_number", async () => {
    const store = await chainStore();
    const wf = store.get("invoice-send")!.workflow;
    const base = testCasesOf(wf)[0]!;
    const db = journalDb();

    const badAmount = {
      ...base,
      id: "verify-wrong-amount",
      stubs: {
        ...base.stubs,
        create: { ...(base.stubs.create as Record<string, unknown>), invoice_amount: 45000 },
      },
    };
    const resAmount = await runDraftTest({ db, harnessVersion: "test", resolveWorkflow: store.resolve }, wf, badAmount);
    expect(resAmount.green).toBe(false);
    expect(resAmount.status).toBe("failed");
    expect(rows<{ form_used: string | null; fallback_taken: string | null; verdict: string | null; failure_class: string | null }>(
      db,
      "SELECT form_used, fallback_taken, verdict, failure_class FROM lane_pilot_wf_step WHERE run_id=? AND node_id='create'",
      resAmount.runId!,
    )[0]).toEqual({
      form_used: "agent",
      fallback_taken: "plan->agent",
      verdict: "fail",
      failure_class: "verify_failed",
    });

    const badNumber = {
      ...base,
      id: "verify-empty-number",
      stubs: {
        ...base.stubs,
        create: { ...(base.stubs.create as Record<string, unknown>), invoice_number: "" },
      },
    };
    const resNumber = await runDraftTest({ db, harnessVersion: "test", resolveWorkflow: store.resolve }, wf, badNumber);
    expect(resNumber.green).toBe(false);
    expect(resNumber.status).toBe("failed");
    expect(rows<{ form_used: string | null; fallback_taken: string | null; verdict: string | null; failure_class: string | null }>(
      db,
      "SELECT form_used, fallback_taken, verdict, failure_class FROM lane_pilot_wf_step WHERE run_id=? AND node_id='create'",
      resNumber.runId!,
    )[0]).toEqual({
      form_used: "agent",
      fallback_taken: "plan->agent",
      verdict: "fail",
      failure_class: "artifact_invalid",
    });

    const badInn = {
      ...base,
      id: "verify-inn-mismatch",
      stubs: {
        ...base.stubs,
        create: { ...(base.stubs.create as Record<string, unknown>), client_inn: "1111111111" },
      },
    };
    const resInn = await runDraftTest({ db, harnessVersion: "test", resolveWorkflow: store.resolve }, wf, badInn);
    expect(resInn.green).toBe(false);
    expect(resInn.status).toBe("failed");
    expect(rows<{ form_used: string | null; fallback_taken: string | null; verdict: string | null; failure_class: string | null }>(
      db,
      "SELECT form_used, fallback_taken, verdict, failure_class FROM lane_pilot_wf_step WHERE run_id=? AND node_id='create'",
      resInn.runId!,
    )[0]).toEqual({
      form_used: "agent",
      fallback_taken: "plan->agent",
      verdict: "fail",
      failure_class: "verify_failed",
    });
  });
});
