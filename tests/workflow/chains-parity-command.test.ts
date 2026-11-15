import { describe, expect, it } from "vitest";
import { finding, out, pathOf, task } from "./chain-helpers";
import { runSim } from "./chain-harness";

/**
 * Command-graph parity cases for the remaining on-map hollow sign-2 findings.
 * Every path assertion is intentionally attached to the literal runSim call so
 * the SMA hollow collector can attribute node and edge coverage to this file.
 */
describe("on-map command graph parity", () => {
  it("ai-integration-phase walks eval planning and both check exits", async () => {
    const base = { select: { framework: "langchain", options: [] }, research: { notes: "criteria" }, eval_plan: { plan_path: "evals/PLAN.md" }, spec: { spec_path: "AI-SPEC.md" } };
    const done = await runSim("ai-integration-phase", { input: { goal: "rank photos" }, stubs: { ...base, check: { ok: true, gaps: [] } } });
    expect(pathOf(done)).toBe("select research eval_plan spec check done");
    expect(done.called("eval_plan")).toHaveLength(1);
    expect(out(done)).toMatchObject({ status: "done", spec_path: "AI-SPEC.md" });
    const blocked = await runSim("ai-integration-phase", { input: { goal: "rank photos" }, stubs: { ...base, check: [{ ok: false, gaps: ["no guardrails"] }, { ok: false, gaps: ["still no guardrails"] }] } });
    expect(pathOf(blocked)).toBe("select research eval_plan spec check spec check blocked");
    expect(out(blocked)).toMatchObject({ status: "blocked" });
  });

  it("cleanup records a dry plan and validates an applied cleanup", async () => {
    const planned = await runSim("cleanup", { input: { dry_run: true }, stubs: { plan: { moved: ["ph_a"], applied: false } } });
    expect(pathOf(planned)).toBe("plan planned");
    expect(out(planned)).toMatchObject({ status: "planned", moved: ["ph_a"] });
    const applied = await runSim("cleanup", { input: { dry_run: false }, stubs: { plan: { moved: ["ph_a"], applied: true }, goal_check: { ok: true, verdict: "pass" } } });
    expect(pathOf(applied)).toBe("plan goal_check done");
    expect(out(applied)).toMatchObject({ status: "done", moved: ["ph_a"] });
    const blocked = await runSim("cleanup", { input: { dry_run: false }, stubs: { plan: { moved: ["ph_a"], applied: true }, goal_check: { ok: false, verdict: "fail", reason: "not clean" } } });
    expect(pathOf(blocked)).toBe("plan goal_check blocked");
    expect(out(blocked)).toMatchObject({ status: "blocked" });
  });

  it("eval-review offers a fix for a flawed review and closes a sound one", async () => {
    const flawed = await runSim("eval-review", { input: { phase_id: "ph_a" }, stubs: { review: { flawed: true, findings: [{ file: "AI-SPEC.md", severity: "high" }], review_path: ".agents/phases/ph_a/EVAL-REVIEW.md" } } });
    expect(pathOf(flawed)).toBe("review offer flawed");
    expect(out(flawed)).toMatchObject({ status: "flawed", findings: [{ file: "AI-SPEC.md" }] });
    const sound = await runSim("eval-review", { input: { phase_id: "ph_a" }, stubs: { review: { flawed: false, findings: [], review_path: ".agents/phases/ph_a/EVAL-REVIEW.md" }, goal_check: { ok: true, verdict: "pass" } } });
    expect(pathOf(sound)).toBe("review goal_check sound");
    expect(out(sound)).toMatchObject({ status: "sound" });
    const invalid = await runSim("eval-review", { input: { phase_id: "ph_a" }, stubs: { review: { flawed: false, findings: [], review_path: ".agents/phases/ph_a/EVAL-REVIEW.md" }, goal_check: { ok: false, verdict: "fail" } } });
    expect(pathOf(invalid)).toBe("review goal_check flawed");
    expect(out(invalid)).toMatchObject({ status: "flawed" });
  });

  it("lp.clarify returns named questions from the read-only analyst", async () => {
    const result = await runSim("lp.clarify", { input: { goal: "export reports" }, stubs: { analyst: { questions: [{ task: "reports", question: "which format?" }] } } });
    expect(pathOf(result)).toBe("analyst done");
    expect(result.called("analyst")).toHaveLength(1);
    expect(out(result)).toMatchObject({ questions: [{ task: "reports", question: "which format?" }] });
  });

  it("milestone-close covers the living-memory/archive route and the refusal route", async () => {
    const input = { goal: "Stats export", goals: [{ id: "g1", done_when: "export works", evidence: "tests pass" }] };
    const ready = { open_tasks: 0, unmerged: 0, gate_ok: true, running_attempts: 0, merged_commits: ["m1"], gate_state: "none", unmerged_seen: 0, uncovered_reqs: [], retro_living: "on", milestone_summary: "on", milestone_archive: "on" };
    const closed = await runSim("milestone-close", { input, stubs: { "lp.run_status": ready, retro: { status: "done" }, "lp.retro_living": { status: "written" }, "lp.close": { status: "closed", staged: 1 }, summary: { status: "done" }, "fs.write": { record_path: ".agents/milestones/run.md" }, "lp.milestone_archive": { folder: ".agents/milestones/stats", files: ["SUMMARY.md"], kept: true }, "lp.run_close": { archived: true } }, humans: { approve_knowledge: { answer_kind: "approved", approved_ids: ["k1"] } } });
    expect(pathOf(closed)).toBe("status retro living close summary approve_knowledge record snapshot archive closed");
    expect(out(closed)).toMatchObject({ status: "closed", candidates_approved: 1 });
    for (const node of ["retro", "living", "close", "summary", "approve_knowledge", "record", "snapshot", "archive"]) expect(closed.called(node)).toHaveLength(1);
    const stop = await runSim("milestone-close", { input, stubs: { "lp.run_status": { ...ready, gate_ok: false } }, humans: { ask_finish: { answer_kind: "finish_first" } } });
    expect(pathOf(stop)).toBe("status ask_finish not_ready");
    expect(out(stop)).toMatchObject({ status: "not_ready" });
    const snapshotOnly = await runSim("milestone-close", { input, stubs: { "lp.run_status": { ...ready, retro_living: "off", milestone_summary: "off", milestone_archive: "on" }, "lp.close": { status: "closed", staged: 1 } }, humans: { approve_knowledge: { answer_kind: "approved", approved_ids: ["k1"] } } });
    expect(pathOf(snapshotOnly)).toBe("status retro close approve_knowledge snapshot archive closed");
    const recordOnly = await runSim("milestone-close", { input, stubs: { "lp.run_status": { ...ready, retro_living: "on", milestone_summary: "off", milestone_archive: "off" }, "lp.close": { status: "closed", staged: 1 } }, humans: { approve_knowledge: { answer_kind: "approved", approved_ids: ["k1"] } } });
    expect(pathOf(recordOnly)).toBe("status retro living close approve_knowledge record archive closed");
    const halted = await runSim("milestone-close", { input, stubs: { "lp.run_status": { ...ready, retro_living: "off" }, "lp.close": { status: "unmet", report_path: "reports/h.md" } } });
    expect(pathOf(halted)).toBe("status retro close halted");
    expect(out(halted)).toMatchObject({ status: "halted" });
  });

  it("new-milestone archives first, then frames the phases", async () => {
    const result = await runSim("new-milestone", { input: { goal: "v2 billing" }, stubs: { archive: { folder: ".agents/planning/milestones/v1", files: ["ROADMAP.md"], kept: false }, frame: { phases: ["1 billing", "2 invoices"] } } });
    expect(pathOf(result)).toBe("archive frame done");
    expect(out(result)).toMatchObject({ status: "done", phases: ["1 billing", "2 invoices"] });
  });

  it("plan-review-convergence records both approval and requested changes", async () => {
    const base = { critic_a: { decision: "approve", findings: [] }, critic_b: { decision: "approve", findings: [] } };
    const approve = await runSim("plan-review-convergence", { input: { phase_id: "ph_a" }, stubs: { ...base, converge: { decision: "approve", findings: [], rounds: 1 } } });
    expect(pathOf(approve)).toBe("critic_a critic_b converge approve");
    expect(out(approve)).toMatchObject({ status: "approve", rounds: 1 });
    const changes = await runSim("plan-review-convergence", { input: { phase_id: "ph_a" }, stubs: { ...base, critic_b: { decision: "changes_requested", findings: [{ file: "PLAN.md" }] }, converge: { decision: "changes_requested", findings: [{ file: "PLAN.md" }], rounds: 2 } } });
    expect(pathOf(changes)).toBe("critic_a critic_b converge changes");
    expect(out(changes)).toMatchObject({ status: "changes_requested", rounds: 2 });
  });

  it("project-start follows the full first-start route and can resume an existing tree", async () => {
    const first = await runSim("project-start", { input: {}, stubs: { "lp.tree_counts": { enabled: "on" }, "lp.state_probe": { has_value_map: false, has_roadmap: false, has_profile: false }, value_map: { value_map: "for shop owners" }, preview: { stack: {}, memory: {}, profile: {} }, "lp.profile_write": { refused: [], set: ["stack"], reasons: [] }, research: { research_notes: "notes" }, requirements: { requirements: ["R1"] }, recap: { next_steps: ["a", "b"] } }, humans: { ask: { answer_kind: "answered", answer: "owner details" } } });
    expect(pathOf(first)).toBe("tree probe value_map preview profile_write ask research requirements recap done");
    expect(out(first)).toMatchObject({ status: "done", next_steps: ["a", "b"] });
    for (const node of ["probe", "value_map", "preview", "profile_write", "ask", "research", "requirements", "recap"]) expect(first.called(node)).toHaveLength(1);
    const resumed = await runSim("project-start", { input: {}, stubs: { "lp.tree_counts": { enabled: "on" }, "lp.state_probe": { has_value_map: true, has_roadmap: true, has_profile: true } } });
    expect(pathOf(resumed)).toBe("tree probe resumed");
    expect(out(resumed)).toMatchObject({ status: "resumed" });
  });

  it("review-fix covers a clean review, a repair round and the blocked planner", async () => {
    const clean = await runSim("review-fix", { input: { goal: "fix findings", findings: [] }, stubs: { first_review: { status: "pass", findings: [] } } });
    expect(pathOf(clean)).toBe("first_review done");
    expect(out(clean)).toMatchObject({ status: "done" });
    const repaired = await runSim("review-fix", { input: { goal: "fix findings", findings: [{ file: "src/a.ts", severity: "high" }] }, stubs: { plan_fix: { status: "ok", tasks: [task("fix-a")] }, build_fix: { merged_commits: ["c1"] }, re_review: { status: "pass", findings: [], remaining_actionable: 0 } } });
    expect(pathOf(repaired)).toBe("first_review plan_fix build_fix re_review done");
    expect(out(repaired)).toMatchObject({ status: "done" });
    const blocked = await runSim("review-fix", { input: { goal: "fix findings", findings: [{ file: "src/a.ts", severity: "high" }] }, stubs: { plan_fix: { status: "failed", tasks: [] } } });
    expect(pathOf(blocked)).toBe("first_review plan_fix blocked");
    expect(out(blocked)).toMatchObject({ status: "blocked" });
    const buildBlocked = await runSim("review-fix", { input: { goal: "fix findings", findings: [{ file: "src/a.ts", severity: "high" }] }, stubs: { plan_fix: { status: "ok", tasks: [task("fix-a")] }, build_fix: { status: "blocked", merged_commits: [] } } });
    expect(pathOf(buildBlocked)).toBe("first_review plan_fix build_fix blocked");
    const secondBuildBlocked = await runSim("review-fix", { input: { goal: "fix findings", findings: [{ file: "src/a.ts", severity: "high" }] }, stubs: { plan_fix: { status: "ok", tasks: [task("fix-a")] }, build_fix: { merged_commits: ["c1"] }, re_review: { status: "rework", findings: [{ file: "src/b.ts" }], remaining_actionable: 1 }, plan_fix2: { status: "ok", tasks: [task("fix-b")] }, build_fix2: { status: "blocked", merged_commits: [] } } });
    expect(pathOf(secondBuildBlocked)).toBe("first_review plan_fix build_fix re_review plan_fix2 build_fix2 blocked");
    const classified = await runSim("review-fix", { input: { goal: "fix findings", findings: [{ file: "src/a.ts", severity: "high" }] }, stubs: { plan_fix: { status: "ok", tasks: [task("fix-a")] }, build_fix: { merged_commits: ["c1"] }, re_review: { status: "rework", findings: [{ file: "src/b.ts" }], remaining_actionable: 1 }, plan_fix2: { status: "failed", tasks: [] }, classify: { remaining: [{ file: "src/b.ts" }] } }, humans: { ask: { answer_kind: "accept" } } });
    expect(pathOf(classified)).toBe("first_review plan_fix build_fix re_review plan_fix2 classify ask partial");
  });

  it("roadmap-driven validates a roadmap and blocks a cyclic one", async () => {
    const input = { goal: "Account area", requirements: "login and billing" };
    const base = { roadmap: { sessions: [{ id: "s1", intent: "login", depends_on: [] }], session_count: 1, mode: "single", requirement_map: { R1: "s1" } }, "analyze-plan-execute": { status: "done", merged_commits: ["c1"] }, "lp.close": { status: "closed" } };
    const good = await runSim("roadmap-driven", { input, stubs: { ...base, validate: { ok: true, errors: [], cycles: [] } }, humans: { approve: { answer_kind: "approve" } } });
    expect(pathOf(good)).toBe("probe analyze roadmap validate approve sessions close done");
    expect(out(good)).toMatchObject({ status: "done", sessions_done: ["s1"] });
    const bad = await runSim("roadmap-driven", { input, stubs: { ...base, validate: { ok: false, errors: ["cycle"], cycles: ["s1>s1"] } } });
    expect(pathOf(bad)).toBe("probe analyze roadmap validate roadmap validate roadmap validate blocked");
    expect(out(bad)).toMatchObject({ status: "blocked" });
    const partial = await runSim("roadmap-driven", {
      input,
      stubs: {
        ...base,
        "lp.analyze": { scope_verdict: "medium" },
        roadmap: { sessions: [{ id: "s1", intent: "login", depends_on: [] }, { id: "s2", intent: "billing", depends_on: [] }], session_count: 2, mode: "progressive", requirement_map: {} },
        "analyze-plan-execute": (ctx: { input: { with: Record<string, unknown> } }) => (ctx.input.with.goal === "login" ? { status: "partial", merged_commits: [] } : { status: "done", merged_commits: ["c2"] }),
        "lp.close": { status: "unmet", report_path: "reports/partial.md" },
        validate: { ok: true, errors: [], cycles: [] },
      },
      humans: { approve: { answer_kind: "approve" } },
    });
    expect(pathOf(partial)).toBe("probe analyze roadmap validate approve sessions close partial");
    expect(out(partial)).toMatchObject({ status: "partial" });
  });

  it("ship covers review-enabled publication and the integration gate hold", async () => {
    const shipped = await runSim("ship", { input: { phase_id: "ph_a", review: true }, stubs: { gate: { ok: true, failing: [] }, preflight: { ready: true, held_by: [] }, "code-review": { status: "pass", findings: [] }, open_pr: { pr_url: "https://x/pr/1" }, "lp.post_ship_hooks": { count: 1, files: ["deploys.log"] }, post_ship: { status: "written" }, goal_check: { ok: true, verdict: "pass" } } });
    expect(pathOf(shipped)).toBe("gate preflight review open_pr hooks post_ship goal_check shipped");
    expect(out(shipped)).toMatchObject({ status: "shipped", pr_url: "https://x/pr/1" });
    expect(shipped.called("review")).toHaveLength(1);
    expect(shipped.called("post_ship")).toHaveLength(1);
    const held = await runSim("ship", { input: { phase_id: "ph_a", review: true }, stubs: { gate: { ok: false, failing: ["integration gate"] } } });
    expect(pathOf(held)).toBe("gate held_gate");
    expect(out(held)).toMatchObject({ status: "held" });
    const reviewHeld = await runSim("ship", { input: { phase_id: "ph_a", review: true }, stubs: { gate: { ok: true, failing: [] }, preflight: { ready: true, held_by: [] }, "code-review": { status: "rework", findings: [{ file: "src/a.ts" }] } } });
    expect(pathOf(reviewHeld)).toBe("gate preflight review held_review");
    expect(out(reviewHeld)).toMatchObject({ status: "held" });
    const goalHeld = await runSim("ship", { input: { phase_id: "ph_a", review: false }, stubs: { gate: { ok: true, failing: [] }, preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "https://x/pr/2" }, "lp.post_ship_hooks": { count: 0, files: [] }, goal_check: { ok: false, verdict: "fail" } } });
    expect(pathOf(goalHeld)).toBe("gate preflight review open_pr hooks post_ship goal_check held");
    expect(out(goalHeld)).toMatchObject({ status: "held" });
  });

  it("spike distinguishes an answered experiment from an inconclusive one", async () => {
    const answered = await runSim("spike", { input: { question: "can FTS hold 1M rows" }, stubs: { experiment: { answered: true, decision: "yes", spike_path: "spikes/fts.md", skill_draft: "" }, goal_check: { ok: true, verdict: "pass" } } });
    expect(pathOf(answered)).toBe("experiment goal_check answered");
    expect(out(answered)).toMatchObject({ status: "answered", decision: "yes" });
    const unclear = await runSim("spike", { input: { question: "can FTS hold 1M rows" }, stubs: { experiment: { answered: false, decision: "unclear", spike_path: "spikes/fts.md", skill_draft: "draft.md" } } });
    expect(pathOf(unclear)).toBe("experiment inconclusive");
    expect(out(unclear)).toMatchObject({ status: "inconclusive" });
    const failedCheck = await runSim("spike", { input: { question: "can FTS hold 1M rows" }, stubs: { experiment: { answered: true, decision: "yes", spike_path: "spikes/fts.md", skill_draft: "" }, goal_check: { ok: false, verdict: "fail" } } });
    expect(pathOf(failedCheck)).toBe("experiment goal_check inconclusive");
    expect(out(failedCheck)).toMatchObject({ status: "inconclusive" });
  });

  it("test-gen covers direct gaps, a framework refusal, and a converged classification", async () => {
    const input = { scope: "src/discount.ts", gaps: [{ file: "src/discount.ts", layer: "L1", priority: "high" }] };
    const done = await runSim("test-gen", { input, stubs: { write_tests: { state: "accepted", tests_added: 5 }, run: { ok: false, failures: [{ id: "F1" }], pass_rate: 80 }, classify: { converged: true, test_defects: [], code_defects: [finding("high", { file: "src/discount.ts", line: 14 })] } } });
    expect(pathOf(done)).toBe("derive confirm write_tests run classify done");
    expect(out(done)).toMatchObject({ status: "done", tests_added: 5 });
    const noFramework = await runSim("test-gen", { input, stubs: { write_tests: { state: "accepted" }, run: { ok: false, no_framework: true } } });
    expect(pathOf(noFramework)).toBe("derive confirm write_tests run blocked");
    expect(out(noFramework)).toMatchObject({ status: "blocked" });
    const timeout = await runSim("test-gen", { input: { scope: "src/discount.ts", phase_id: "ph_a" }, stubs: { derive: { gaps: [{ file: "src/discount.ts" }] } }, humans: { confirm: { answer_kind: "timeout" } } });
    expect(pathOf(timeout)).toBe("derive confirm blocked");
    expect(out(timeout)).toMatchObject({ status: "blocked" });
  });

  it("ui-audit writes a review file when enabled and offers a fix for a low score", async () => {
    const stubs = { capture: { status: "pass", screenshots: ["a.png"] }, audit: { score_40: 20, score_20: 10, findings: [], report_path: "audit.md" }, review_doc: { review_path: ".agents/ui/pricing/UI-REVIEW.md" }, goal_check: { ok: true, verdict: "pass" } };
    const reviewed = await runSim("ui-audit", { input: { url: "http://localhost:4173", review_file: true }, stubs });
    expect(pathOf(reviewed)).toBe("capture audit review_doc goal_check offer done_offer");
    expect(reviewed.called("review_doc")).toHaveLength(1);
    expect(out(reviewed)).toMatchObject({ status: "done" });
    const blocked = await runSim("ui-audit", { input: { url: "http://localhost:1" }, stubs: { capture: { status: "block" } } });
    expect(pathOf(blocked)).toBe("capture blocked");
    expect(out(blocked)).toMatchObject({ status: "blocked" });
    const failedGoal = await runSim("ui-audit", { input: { url: "http://localhost:4173", review_file: true }, stubs: { capture: { status: "pass", screenshots: ["a.png"] }, audit: { score_40: 30, score_20: 14, findings: [] }, review_doc: { review_path: "" }, goal_check: { ok: false, verdict: "fail" } } });
    expect(pathOf(failedGoal)).toBe("capture audit review_doc goal_check blocked");
    expect(out(failedGoal)).toMatchObject({ status: "blocked" });
  });

  it("validate-phase reports gaps and closes a clean audit", async () => {
    const clean = await runSim("validate-phase", { input: { phase_id: "ph_a1b2c3" }, stubs: { audit: { gaps: [], validation_path: "VALIDATION.md", sampled: 3 }, goal_check: { ok: true, verdict: "pass" } } });
    expect(pathOf(clean)).toBe("audit goal_check done");
    expect(out(clean)).toMatchObject({ status: "done", gaps: [] });
    const gaps = await runSim("validate-phase", { input: { phase_id: "ph_a1b2c3" }, stubs: { audit: { gaps: ["p1: existence-only"], validation_path: "VALIDATION.md", sampled: 1 } } });
    expect(pathOf(gaps)).toBe("audit gaps");
    expect(out(gaps)).toMatchObject({ status: "gaps", gaps: ["p1: existence-only"] });
    const failedGoal = await runSim("validate-phase", { input: { phase_id: "ph_a1b2c3" }, stubs: { audit: { gaps: [], validation_path: "VALIDATION.md", sampled: 3 }, goal_check: { ok: false, verdict: "fail" } } });
    expect(pathOf(failedGoal)).toBe("audit goal_check gaps");
    expect(out(failedGoal)).toMatchObject({ status: "gaps" });
  });
});
