import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

// The SMA map's command workflows (W17): each takes its happy path and its other exit on stubs.
describe("SMA command workflows", () => {
  it("validate-phase: no gaps is done, a gap is reported", async () => {
    const clean = await runSim("validate-phase", { input: { phase_id: "ph_a1b2c3" }, stubs: { audit: { gaps: [], document: "# Validation report", sampled: 3 } } });
    expect(pathOf(clean)).toBe("audit doc_path write_validation goal_check done");
    const gap = await runSim("validate-phase", { input: { phase_id: "ph_a1b2c3" }, stubs: { audit: { gaps: ["p1: existence only"], document: "# Validation report", sampled: 1 } } });
    expect(pathOf(gap)).toBe("audit doc_path write_validation gaps");
    expect(out(gap)).toMatchObject({ status: "gaps", gaps: ["p1: existence only"] });
  });

  it("eval-review: sound or flawed", async () => {
    expect(pathOf(await runSim("eval-review", { input: { phase_id: "ph_a" }, stubs: { review: { findings: [], document: "# Evaluation review", flawed: false } } }))).toBe("review doc_path write_review goal_check sound");
    expect(out(await runSim("eval-review", { input: { phase_id: "ph_a" }, stubs: { review: { findings: [], document: "# Evaluation review", flawed: true } } }))).toMatchObject({ status: "flawed" });
  });

  it("ai-integration-phase: select, research, spec", async () => {
    const r = await runSim("ai-integration-phase", { input: { goal: "rank photos" }, stubs: { select: { framework: "langchain", options: [] }, research: { notes: "ok" }, write_spec: { spec_path: "AI-SPEC.md" } } });
    expect(pathOf(r)).toBe("select write_model research eval_plan spec spec_path write_spec check done");
    expect(out(r)).toMatchObject({ status: "done", framework: "langchain", spec_path: "AI-SPEC.md" });
  });

  it("audit-uat: open items across phases go to UAT-AUDIT.md", async () => {
    const r = await runSim("audit-uat", { input: {}, stubs: { audit: { open_count: 2, document: "# UAT audit" }, goal_check: { ok: true, verdict: "pass", reason: "", details: {} } } });
    expect(pathOf(r)).toBe("audit write goal_check done");
    expect(out(r)).toMatchObject({ status: "done", open_count: 2 });
  });

  it("spike: answered or inconclusive", async () => {
    expect(pathOf(await runSim("spike", { input: { question: "can fts hold 1M rows" }, stubs: { experiment: { answered: true, decision: "yes", document: "# Spike findings", skill_draft: "" } } }))).toBe("spike_new experiment write_spike skill_dir write_skill goal_check answered");
    expect(pathOf(await runSim("spike", { input: { question: "can fts hold 1M rows" }, stubs: { experiment: { answered: false, decision: "", document: "# Spike findings", skill_draft: "" } } }))).toBe("spike_new experiment write_spike skill_dir write_skill inconclusive");
  });

  it("ship: a ready phase is shipped, a held one says what holds it", async () => {
    const shipped = await runSim("ship", { input: { phase_id: "ph_a" }, stubs: { preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "https://x/pr/1" }, "lp.post_ship_hooks": { count: 0, files: [] } } });
    expect(pathOf(shipped)).toBe("gate preflight review_range review open_pr write_deploy_log state_mark hooks post_ship goal_check shipped");
    expect(shipped.skipped).toEqual(["review", "post_ship"]);
    const held = await runSim("ship", { input: { phase_id: "ph_a" }, stubs: { preflight: { ready: false, held_by: ["no full gate marker"] } } });
    expect(pathOf(held)).toBe("gate preflight held");
    expect(out(held)).toMatchObject({ status: "held", held_by: ["no full gate marker"] });
  });

  it("pr-branch: done, or blocked on a conflict", async () => {
    expect(pathOf(await runSim("pr-branch", { input: { phase_id: "ph_a" }, stubs: { split: { branch: "review/ph_a", commits: 3, conflict: false } } }))).toBe("split done");
    expect(pathOf(await runSim("pr-branch", { input: { phase_id: "ph_a" }, stubs: { split: { branch: "review/ph_a", commits: 1, conflict: true } } }))).toBe("split blocked");
  });

  it("cleanup: a dry run plans, an applied one is done", async () => {
    expect(pathOf(await runSim("cleanup", { input: { dry_run: true }, stubs: { plan: { moved: ["ph_a"], applied: false } } }))).toBe("plan planned");
    expect(pathOf(await runSim("cleanup", { input: { dry_run: false }, stubs: { plan: { moved: ["ph_a"], applied: true } } }))).toBe("plan save goal_check done");
  });

  it("new-milestone: the frame and its phases", async () => {
    expect(out(await runSim("new-milestone", { input: { goal: "v2 billing" }, stubs: { frame: { phases: ["1 billing", "2 invoices"] } } }))).toMatchObject({ status: "done", phases: ["1 billing", "2 invoices"] });
  });

  it("plan-review-convergence: both approve, or the merged findings go back", async () => {
    const phaseStatus = { status: { plan: { sha: "plan-sha" } } };
    const phaseCheck = { status: "recorded", phase_id: "ph_a", decision: "approve" };
    const approve = await runSim("plan-review-convergence", { input: { phase_id: "ph_a" }, stubs: { phase_status: phaseStatus, critic_a: { decision: "approve", findings: [] }, critic_b: { decision: "approve", findings: [] }, converge: { decision: "approve", findings: [], rounds: 1 }, "lp.phase_plan_check": phaseCheck } });
    expect(pathOf(approve)).toBe("phase_status proof phase_check approve");
    const changes = await runSim("plan-review-convergence", { input: { phase_id: "ph_a" }, stubs: { phase_status: phaseStatus, critic_a: { decision: "approve", findings: [] }, critic_b: { decision: "changes_requested", findings: [] }, converge: { decision: "changes_requested", findings: [], rounds: 2 }, "lp.phase_plan_check": { ...phaseCheck, decision: "changes_requested" } } });
    expect(pathOf(changes)).toBe("phase_status proof phase_check changes");
    expect(out(changes)).toMatchObject({ status: "changes_requested", rounds: 2 });
    const child = approve.db.prepare("SELECT inputs_json FROM lane_pilot_wf_run WHERE parent_run_id=? ORDER BY rowid").get(approve.summary.runId) as { inputs_json: string };
    expect(JSON.parse(child.inputs_json)).toMatchObject({ phase_id: "ph_a", plan_sha: "plan-sha", phase_status: phaseStatus.status });
  });

  it("plan-review-convergence-proof: both critics approve independently", async () => {
    const proof = await runSim("plan-review-convergence-proof", { input: { phase_id: "ph_a", plan_sha: "plan-sha", phase_status: {} }, stubs: { critic_a: { decision: "approve", findings: [] }, critic_b: { decision: "approve", findings: [] }, converge: { decision: "approve", findings: [], rounds: 1 } } });
    expect(pathOf(proof)).toBe("critic_a critic_b converge approve");
    expect(out(proof)).toMatchObject({ status: "ok", decision: "approve", plan_verdict: "pass" });
  });

  it("project-start: value map, preview, recap", async () => {
    const r = await runSim("project-start", { input: {}, stubs: { "lp.tree_counts": { enabled: "off" }, value_map: { document: "for shop owners" }, preview: { stack: {}, memory: {} }, recap: { next_steps: ["a", "b", "c"] } } });
    expect(pathOf(r)).toBe("tree probe value_map write_value_map preview profile_write ask research write_research_stack write_research_features write_research_architecture write_research_pitfalls requirements write_requirements recap write_roadmap write_project add_phases done");
    expect(r.skipped).toEqual(["probe", "profile_write", "ask", "research", "write_research_stack", "write_research_features", "write_research_architecture", "write_research_pitfalls", "requirements", "write_requirements", "write_project", "add_phases"]);
    expect(out(r)).toMatchObject({ status: "done", next_steps: ["a", "b", "c"] });
  });
});
