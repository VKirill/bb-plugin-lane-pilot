import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

/**
 * milestone-summary must not emit status:"done" when deliverable.validate rejects the artifact.
 * Regression for C-mileage-goalcheck-theater: goal_check->done was unconditional and the emit
 * hardcoded "done", so a rework/fail verdict still produced a done report.
 * The engine run itself succeeds; the business result is status:"blocked".
 * deliverable.validate is stubbed by action name; summary agent is stubbed by node id.
 */
const SUMMARY = { summary_path: "stub", open_items: ["wire the export button"] };
const input = { milestone: "Stats export" };
const VALIDATE = (verdict: "pass" | "rework" | "fail", ok = verdict === "pass") =>
  ({ ok, verdict, reason: ok ? "" : `validator says ${verdict}`, details: {} });

describe("milestone-summary goal_check gate", () => {
  it("a pass verdict emits done with the summary fields", async () => {
    const r = await runSim("milestone-summary", { input, stubs: { summary: SUMMARY, "deliverable.validate": VALIDATE("pass") } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("summary write_summary goal_check done");
    expect(out(r)).toMatchObject({ status: "done", summary_path: SUMMARY.summary_path, open_items: SUMMARY.open_items });
  });

  it("a rework verdict produces a blocked result that still carries the summary fields", async () => {
    const r = await runSim("milestone-summary", { input, stubs: { summary: SUMMARY, "deliverable.validate": VALIDATE("rework") } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("summary write_summary goal_check blocked");
    expect(out(r)).toMatchObject({ status: "blocked", summary_path: SUMMARY.summary_path, open_items: SUMMARY.open_items });
    expect(out(r)).not.toMatchObject({ status: "done" });
  });

  it("a fail verdict produces a blocked result", async () => {
    const r = await runSim("milestone-summary", { input, stubs: { summary: SUMMARY, "deliverable.validate": VALIDATE("fail") } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("summary write_summary goal_check blocked");
    expect(out(r)).toMatchObject({ status: "blocked", summary_path: SUMMARY.summary_path, open_items: SUMMARY.open_items });
  });
});
