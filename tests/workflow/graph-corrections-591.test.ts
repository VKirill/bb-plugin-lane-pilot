import { describe, expect, it } from "vitest";
import { finding, firstInput, out, pathOf, task } from "./chain-helpers";
import { runSim } from "./chain-harness";

/**
 * review591 graph corrections: cleanup validates a real written report, ship keeps the PR and hook
 * evidence on a post-PR validation hold, debug fans out over a typed failures list so a string
 * symptom can never reach for_each.
 */
describe("graph corrections 591", () => {
  it("cleanup applied path writes the report and hands its path to deliverable.validate", async () => {
    const r = await runSim("cleanup", {
      input: { dry_run: false },
      stubs: {
        plan: { moved: ["ph_a", "spike_old"], applied: true },
        "fs.write": { cleanup_path: "plans/cleanup-run1.json" },
        goal_check: { ok: true, verdict: "pass" },
      },
    });
    expect(pathOf(r)).toBe("plan save goal_check done");
    expect(r.called("save")).toHaveLength(1);
    expect(firstInput(r, "goal_check")).toMatchObject({ path: "plans/cleanup-run1.json" });
    expect(out(r)).toMatchObject({ status: "done", moved: ["ph_a", "spike_old"] });
    const save = r.workflow.nodes.find((node) => node.id === "save");
    expect(save).toMatchObject({ action: "fs.write" });
  });

  it("cleanup dry run still plans without writing a report", async () => {
    const r = await runSim("cleanup", { input: { dry_run: true }, stubs: { plan: { moved: ["ph_a"], applied: false } } });
    expect(pathOf(r)).toBe("plan planned");
    expect(r.called("save")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "planned", moved: ["ph_a"] });
  });

  it("ship held after a real PR keeps the PR url and the hook evidence", async () => {
    const r = await runSim("ship", {
      input: { phase_id: "ph_a", review: false },
      stubs: {
        gate: { ok: true, failing: [] },
        preflight: { ready: true, held_by: [] },
        open_pr: { pr_url: "https://x/pr/9" },
        "lp.post_ship_hooks": { count: 1, files: ["deploys.log"] },
        post_ship: { hooks_run: ["deploy"], hooks_failed: ["notify hook"] },
        goal_check: { ok: false, verdict: "fail", reason: "deliverable missing" },
      },
    });
    expect(pathOf(r)).toBe("gate preflight review_range review open_pr write_deploy_log state_mark hooks post_ship goal_check held_validate");
    expect(out(r)).toMatchObject({
      status: "held",
      pr_url: "https://x/pr/9",
      hooks_failed: ["notify hook"],
      held_by: ["deliverable validation failed after the PR was opened", "deliverable missing"],
    });
  });

  it("ship preflight hold still reports the preflight reasons", async () => {
    const r = await runSim("ship", { input: { phase_id: "ph_a" }, stubs: { preflight: { ready: false, held_by: ["no full gate marker"] } } });
    expect(pathOf(r)).toBe("gate preflight held");
    expect(out(r)).toMatchObject({ status: "held", held_by: ["no full gate marker"], pr_url: "" });
  });

  it("debug from_failures with a string symptom investigates instead of reaching for_each", async () => {
    const found = { status: "confirmed", confidence: 82, pressure_pass: true, contradictions: 0, affected_files: ["src/a.ts"], refuted: 1, root_cause: "cause", fix_direction: "fix" };
    const r = await runSim("debug", {
      input: { symptom: "check p1 is red after the merge", mode: "from_failures" },
      stubs: { investigate: found, verify_cause: { confirmed: true } },
    });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("ask_symptoms normalize investigate write_investigation_session write_investigation_evidence verify_cause write_verification_session write_verification_evidence confirmed");
    expect(r.called("diagnose:child")).toHaveLength(0);
  });

  it("debug from_failures fans out one debugger per failures entry", async () => {
    const r = await runSim("debug", {
      input: { mode: "from_failures", failures: [{ file: "a.ts", severity: "high" }, { file: "b.ts", severity: "medium" }] },
    });
    expect(pathOf(r)).toBe("ask_symptoms normalize diagnose diagnosed");
    expect(r.called("diagnose:child")).toHaveLength(2);
  });

  it("debug from_failures still fans out a legacy symptom array (public string|Finding[] contract)", async () => {
    const r = await runSim("debug", {
      input: { mode: "from_failures", symptom: ["check p1 red", "check p2 red", "check p3 red"] },
    });
    expect(pathOf(r)).toBe("ask_symptoms normalize diagnose diagnosed");
    expect(r.called("diagnose:child")).toHaveLength(3);
  });

  it("debug typed failures win over a legacy symptom array", async () => {
    const r = await runSim("debug", {
      input: { mode: "from_failures", failures: ["typed one"], symptom: ["legacy one", "legacy two"] },
    });
    expect(pathOf(r)).toBe("ask_symptoms normalize diagnose diagnosed");
    expect(r.called("diagnose:child")).toHaveLength(1);
  });

  it("debug rejects a non-array failures input instead of crashing in for_each", async () => {
    await expect(runSim("debug", { input: { mode: "from_failures", failures: "not-a-list" } })).rejects.toThrow();
  });

  it("quality-loop hands classify.code_defects to debug's failures input", async () => {
    const r = await runSim("quality-loop", {
      input: { scope: "src/orders", quality_mode: "standard" },
      stubs: {
        review: [{ status: "rework", findings: [finding("high", { file: "src/orders/total.ts", line: 31 })] }, { status: "pass" }],
        coverage: { gap_count: 0, framework_found: true },
        "test-gen": { status: "done", tests_added: 0 },
        classify: [{ code_defect_count: 1, code_defects: [finding("high", { file: "src/orders/total.ts" })] }, { code_defect_count: 0 }],
        debug: { status: "confirmed", fix_directions: ["use integer cents"], diagnosis: "cents" },
        replan: { status: "ok", tasks: [task("q1")] },
        "lp.build": { status: "done", merged_commits: ["q1"] },
        qa: { status: "pass" },
      },
    });
    expect(firstInput(r, "diagnose")).toMatchObject({
      mode: "from_failures",
      failures: [expect.objectContaining({ file: "src/orders/total.ts" })],
    });
  });
});
