import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

describe("audit-uat output contract", () => {
  it("keeps the written audit outputs while ending blocked on a failed goal check", async () => {
    const result = await runSim("audit-uat", {
      input: { propose_followup: true },
      stubs: {
        audit: { open_count: 2, document: "# UAT audit\n- p1 open" },
        goal_check: { ok: false, verdict: "rework", reason: "audit artifact is incomplete", details: {} },
      },
    });

    expect(pathOf(result)).toBe("audit write goal_check blocked");
    expect(out(result)).toMatchObject({ status: "blocked", open_count: 2, audit_path: expect.any(String) });
    expect(out(result)).not.toHaveProperty("proposed_workflow");
  });

  it("still offers a follow-up only after a passing goal check", async () => {
    const result = await runSim("audit-uat", {
      input: { propose_followup: true },
      stubs: {
        audit: { open_count: 2, document: "# UAT audit\n- p1 open" },
        goal_check: { ok: true, verdict: "pass", reason: "", details: {} },
        offer: { proposed: true },
      },
    });

    expect(pathOf(result)).toBe("audit write goal_check offer done_offer");
    expect(out(result)).toMatchObject({ status: "done", open_count: 2, proposed_workflow: "analyze-plan-execute" });
  });
});
