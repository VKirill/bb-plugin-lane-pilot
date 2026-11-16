import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

describe("graph residual outputs 591", () => {
  it("milestone-close does not call skipped knowledge approval deferred", async () => {
    const result = await runSim("milestone-close", {
      input: { goal: "empty close", goals: [] },
      stubs: {
        "lp.run_status": { open_tasks: 0, failed_tasks: 0, unmerged: 0, gate_ok: true, running_attempts: 0, merged_commits: [], gate_state: "none", unmerged_seen: 0, uncovered_reqs: [] },
        "lp.close": { status: "closed", staged: 0, report_path: "reports/close.md" },
      },
    });
    expect(result.skipped).toContain("approve_knowledge");
    expect(out(result)).toMatchObject({ status: "closed", candidates_staged: 0, candidates_approved: 0, deferred: false });
  });

  it("audit-uat exposes the proposed workflow only on the offer path", async () => {
    const offered = await runSim("audit-uat", {
      input: { propose_followup: true },
      stubs: { audit: { open_count: 2, document: "# UAT audit" }, goal_check: { ok: true, verdict: "pass", reason: "", details: {} } },
    });
    expect(pathOf(offered)).toBe("audit write goal_check offer done_offer");
    expect(out(offered)).toMatchObject({ status: "done", proposed_workflow: "analyze-plan-execute" });

    const plain = await runSim("audit-uat", {
      input: { propose_followup: false },
      stubs: { audit: { open_count: 2, document: "# UAT audit" }, goal_check: { ok: true, verdict: "pass", reason: "", details: {} } },
    });
    expect(pathOf(plain)).toBe("audit write goal_check done");
    expect(out(plain)).not.toHaveProperty("proposed_workflow");
  });

  it("plan-only preserves a low-confidence planner result", async () => {
    const result = await runSim("plan-only", {
      input: { goal: "draft a plan" },
      stubs: { "lp.plan": { status: "low_confidence", tasks: [], waves: [], plan_verdict: "uncertain" }, save: { plan_path: "plans/draft.json" } },
    });
    expect(out(result)).toMatchObject({ status: "low_confidence", plan_path: "plans/draft.json" });
  });
});
