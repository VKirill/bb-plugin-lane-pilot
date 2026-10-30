import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { failureIntervention, MAST_OF_FAILURE } from "../src/rooms/runs/failure-class";
import { failureClassLive, failureClassReport } from "../src/rooms/runs/failure-class-model";
import { insertReceipt } from "@lane-pilot/jev";
import { migrations, openDatabase } from "../src/rooms/storage/database";

const receiptRow = (decision = "task") => ({
  judgment: "failure.class", version: 1, model: "jev-1", mode: "shadow", projectId: "p", runId: "r",
  subject: "attempt", inputSha256: "x", inputChars: 10, questions: 1, batchSize: 1, status: "ok" as const,
  decision, decidedBy: "fallback" as const, latencyMs: 1,
});

// A labeled receipt: the outcome column the sweep would have written from the run's terminal state.
const labeled = (db: ReturnType<typeof openDatabase>, outcome: string) => {
  insertReceipt(db, receiptRow());
  db.prepare("UPDATE lane_pilot_jev_receipt SET outcome=? WHERE id=(SELECT max(id) FROM lane_pilot_jev_receipt)").run(outcome);
};

describe("failure interventions by class (C6)", () => {
  it("maps each class to a different action instead of the same retry", () => {
    expect(failureIntervention("provider", 1)).toBe("next_writer");
    expect(failureIntervention("limit", 1)).toBe("next_writer");
    expect(failureIntervention("merge", 1)).toBe("free_redo");
    expect(failureIntervention("infra", 3)).toBe("park");
    expect(failureIntervention("harness", 1)).toBe("park");
    expect(failureIntervention("contract", 1)).toBe("park");
    expect(failureIntervention("task", 1)).toBe("same_retry_remark");
    expect(failureIntervention("task", 2)).toBe("narrow_brief");
    expect(failureIntervention("task", 4)).toBe("narrow_brief");
    expect(failureIntervention("verification_timeout", 1)).toBe("same_retry_remark");
  });

  it("gives every class a MAST-14 bucket for the receipts", () => {
    for (const cls of ["task", "provider", "harness", "infra", "merge", "contract", "dirty_base", "judgment", "budget", "limit", "reassign", "verification_timeout"]) {
      expect(MAST_OF_FAILURE[cls]).toMatch(/^(specification|misalignment|verification|external):/);
    }
    expect(MAST_OF_FAILURE.task).toBe("verification:incomplete_work");
    expect(MAST_OF_FAILURE.merge).toBe("misalignment:base_moved");
  });
});

describe("the failure.class shadow->live gate", () => {
  it("stays shadow without labels, goes live at 10+ labels and 75% agreement, and the report says why", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    expect(failureClassReport(db)).toMatchObject({ live: false, calls: 0, labeled: 0 });
    expect(failureClassReport(db).reason).toContain("never called");
    for (let i = 0; i < 10; i++) labeled(db, i < 8 ? "agree" : "disagree");
    const report = failureClassReport(db);
    expect(report).toMatchObject({ calls: 10, labeled: 10, agree: 8, disagree: 2, live: true });
    expect(failureClassLive(db)).toBe(true);
    // Under the agreement gate it stays shadow and the report names the cause.
    const { bb: bb2, harness: harness2 } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db2 = openDatabase(bb2);
    for (let i = 0; i < 12; i++) labeled(db2, i < 7 ? "agree" : "disagree");
    const cold = failureClassReport(db2);
    expect(cold.live).toBe(false);
    expect(cold.reason).toContain("under the 75% gate");
    await harness.lifecycle.dispose();
    await harness2.lifecycle.dispose();
  });
});
