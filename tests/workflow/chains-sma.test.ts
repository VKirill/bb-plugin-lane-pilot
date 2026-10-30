import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

// The SMA map's command workflows (W17): each takes its happy path and its other exit on stubs.
describe("SMA command workflows", () => {
  it("validate-phase: no gaps is done, a gap is reported", async () => {
    const clean = await runSim("validate-phase", { input: { phase_id: "ph_a1b2c3" }, stubs: { audit: { gaps: [], validation_path: "v.md", sampled: 3 } } });
    expect(pathOf(clean)).toBe("audit goal_check done");
    const gap = await runSim("validate-phase", { input: { phase_id: "ph_a1b2c3" }, stubs: { audit: { gaps: ["p1: existence only"], validation_path: "v.md", sampled: 1 } } });
    expect(pathOf(gap)).toBe("audit gaps");
    expect(out(gap)).toMatchObject({ status: "gaps", gaps: ["p1: existence only"] });
  });

  it("eval-review: sound or flawed", async () => {
    expect(pathOf(await runSim("eval-review", { input: { phase_id: "ph_a" }, stubs: { review: { findings: [], review_path: "e.md", flawed: false } } }))).toBe("review goal_check sound");
    expect(out(await runSim("eval-review", { input: { phase_id: "ph_a" }, stubs: { review: { findings: [], review_path: "e.md", flawed: true } } }))).toMatchObject({ status: "flawed" });
  });

  it("ai-integration-phase: select, research, spec", async () => {
    const r = await runSim("ai-integration-phase", { input: { goal: "rank photos" }, stubs: { select: { framework: "typesafe", options: [] }, research: { notes: "ok" }, spec: { spec_path: "AI-SPEC.md" } } });
    expect(pathOf(r)).toBe("select research spec done");
    expect(out(r)).toMatchObject({ status: "done", framework: "typesafe", spec_path: "AI-SPEC.md" });
  });

  it("spike: answered or inconclusive", async () => {
    expect(pathOf(await runSim("spike", { input: { question: "can fts hold 1M rows" }, stubs: { experiment: { answered: true, decision: "yes", spike_path: "s.md", skill_draft: "" } } }))).toBe("experiment goal_check answered");
    expect(pathOf(await runSim("spike", { input: { question: "can fts hold 1M rows" }, stubs: { experiment: { answered: false, decision: "", spike_path: "s.md", skill_draft: "" } } }))).toBe("experiment inconclusive");
  });

  it("ship: a ready phase is shipped, a held one says what holds it", async () => {
    const shipped = await runSim("ship", { input: { phase_id: "ph_a" }, stubs: { preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "https://x/pr/1" } } });
    expect(pathOf(shipped)).toBe("preflight open_pr goal_check shipped");
    const held = await runSim("ship", { input: { phase_id: "ph_a" }, stubs: { preflight: { ready: false, held_by: ["no full gate marker"] } } });
    expect(pathOf(held)).toBe("preflight held");
    expect(out(held)).toMatchObject({ status: "held", held_by: ["no full gate marker"] });
  });

  it("pr-branch: done, or blocked on a conflict", async () => {
    expect(pathOf(await runSim("pr-branch", { input: { phase_id: "ph_a" }, stubs: { split: { branch: "review/ph_a", commits: 3, conflict: false } } }))).toBe("split done");
    expect(pathOf(await runSim("pr-branch", { input: { phase_id: "ph_a" }, stubs: { split: { branch: "review/ph_a", commits: 1, conflict: true } } }))).toBe("split blocked");
  });

  it("cleanup: a dry run plans, an applied one is done", async () => {
    expect(pathOf(await runSim("cleanup", { input: { dry_run: true }, stubs: { plan: { moved: ["ph_a"], applied: false } } }))).toBe("plan planned");
    expect(pathOf(await runSim("cleanup", { input: { dry_run: false }, stubs: { plan: { moved: ["ph_a"], applied: true } } }))).toBe("plan goal_check done");
  });

  it("new-milestone: the frame and its phases", async () => {
    expect(out(await runSim("new-milestone", { input: { goal: "v2 billing" }, stubs: { frame: { phases: ["1 billing", "2 invoices"] } } }))).toMatchObject({ status: "done", phases: ["1 billing", "2 invoices"] });
  });

  it("plan-review-convergence: both approve, or the merged findings go back", async () => {
    const approve = await runSim("plan-review-convergence", { input: { phase_id: "ph_a" }, stubs: { critic_a: { decision: "approve", findings: [] }, critic_b: { decision: "approve", findings: [] }, converge: { decision: "approve", findings: [], rounds: 1 } } });
    expect(pathOf(approve)).toBe("critic_a critic_b converge approve");
    const changes = await runSim("plan-review-convergence", { input: { phase_id: "ph_a" }, stubs: { critic_a: { decision: "approve", findings: [] }, critic_b: { decision: "changes_requested", findings: [] }, converge: { decision: "changes_requested", findings: [], rounds: 2 } } });
    expect(out(changes)).toMatchObject({ status: "changes_requested", rounds: 2 });
  });

  it("project-start: value map, preview, recap", async () => {
    const r = await runSim("project-start", { input: {}, stubs: { value_map: { value_map: "for shop owners" }, preview: { stack: {}, memory: {} }, recap: { next_steps: ["a", "b", "c"] } } });
    expect(pathOf(r)).toBe("value_map preview recap done");
    expect(out(r)).toMatchObject({ status: "done", next_steps: ["a", "b", "c"] });
  });
});
