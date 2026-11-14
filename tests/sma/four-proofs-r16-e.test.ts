// Region 16 (slash commands and workflows), batch e: the plan check and admission, the review / audit / QA workflows and the live check (n1268 … n1297).
// Every test runs the real code of the node through tests/sma/r16-world-e.ts (the same observations the scene scripts/lp_drill/scenes/sma_r16_e.py proves) and checks the
// result the card names: what a gate refuses, which path a workflow takes and what it emits, what was written and committed.
import { describe, expect, it } from "vitest";
import { observeE } from "./r16-world-e";

const NO_RUN = "the plan check is not proven independent: it names no workflow run: report the wfRunId of the lp.plan run whose plan critic approved";

describe("phase planning (n1268 … n1275)", () => {
  it("[sma:k_wp_checker] no plan passes without an independent check: a missing check, a check that asked for changes and a check not proven independent are each refused by name", () => {
    const seen = observeE.k_wp_checker();
    expect(seen.approved).toEqual([]);
    expect(seen.noCheck).toEqual(["no independent plan check: run the plan critic (workflow lp.plan) and report its decision with the run's wfRunId"]);
    expect(seen.changes).toEqual(["the plan checker asked for changes: split p1"]);
    expect(seen.notIndependent).toEqual(["the plan check is not proven independent: same thread"]);
    expect(seen.noRun).toEqual([NO_RUN]);
  });

  it("[sma:k_wp_revision] the checker's concerns send the plan back to the planner twice more at most: after the third round of changes the machine stops planning and the gate says to return to discussion", () => {
    const seen = observeE.k_wp_revision();
    expect(seen.max).toBe(3);
    expect(seen.due).toEqual(["plan", "plan", "plan", null]);
    expect(seen.gate2).toEqual(["the plan checker asked for changes"]);
    expect(seen.gate3).toEqual(["3 rounds of the plan check asked for changes: stop revising — return the phase to discussion with what the checker keeps finding, or close it", "the plan checker asked for changes"]);
    expect(seen.gate3approved).toEqual([]);
  });

  it("[sma:k_wp_bounce] the external bounce is due once per plan sha, only when the project asks for it and the checker approved; its «changes» send the plan round again, its approval changes nothing", async () => {
    const seen = await observeE.k_wp_bounce();
    expect(seen.due).toBe("bounce");
    expect(seen.off).toBeNull();
    expect(seen.done).toBeNull();
    expect(seen.otherSha).toBe("bounce");
    expect(seen.unchecked).toBe("check");
    expect(seen.changes.bounce).toMatchObject({ decision: "changes_requested", rounds: 2 });
    expect(seen.changes.gaps).toBe('the external plan bounce asked for changes: [{"text":"narrow');
    expect(seen.changes.booked).toContain("bounce:external plan bounce");
    expect(seen.approve).toEqual({ decision: "approve", replan: null });
    expect(seen.again).toBe(0);
  });

  it("[sma:k_wp_reqgate] a requirement of the signed context that no piece covers is named and the plan is refused; covered, or a goal already met, passes", () => {
    const seen = observeE.k_wp_reqgate();
    const gap = (ids: string) => `requirements no piece covers: ${ids} (name them in a piece's covers, or defer them in CONTEXT.md and sign again)`;
    expect(seen.open).toEqual([gap("R2")]);
    expect(seen.all).toEqual([]);
    expect(seen.none).toEqual([gap("R1, R2")]);
    expect(seen.noContext).toEqual([]);
    expect(seen.gate).toEqual([gap("R2")]);
    expect(seen.gateAll).toEqual([]);
    expect(seen.alreadyMet).toEqual([]);
  });

  it("[sma:k_wp_decgate] a locked decision of the signed context that no piece carries out is named and the plan is refused; each gate names only its own gap", () => {
    const seen = observeE.k_wp_decgate();
    const req = "requirements no piece covers: R2 (name them in a piece's covers, or defer them in CONTEXT.md and sign again)";
    expect(seen.open).toEqual(["locked decisions no piece carries out: D1"]);
    expect(seen.all).toEqual([]);
    expect(seen.none).toEqual(["locked decisions no piece carries out: D1, D2"]);
    expect(seen.both).toEqual([req, "locked decisions no piece carries out: D1"]);
    expect(seen.gate).toEqual(["locked decisions no piece carries out: D2"]);
    expect(seen.gateAll).toEqual([]);
  });

  it("[sma:k_wp_state] a closed phase leaves its row ticked in the roadmap and its phase and stage in STATE.md, and nothing else in either file changes", async () => {
    const seen = await observeE.k_wp_state();
    expect(seen.stateHas).toEqual([true, true, true, true]);
    expect(seen.rows).toEqual(["- [x] 1.1 Hud — build it", "- [ ] 1.2 Menu — the menu", "- [ ] 999.1 Later — parked"]);
    expect(seen.unknown).toBe(true);
    expect(seen.closed).toBe(true);
  });

  it("[sma:k_wp_commit] the admitted plan is written as PLAN.md with a section per wave and committed; with the document switch off nothing is written, with the commit switch off it is written and not committed", async () => {
    const seen = await observeE.k_wp_commit();
    const plan = ["<!-- lp:generated -->", "# Plan — phase <id>: Hud", "Goal: hud", "Objective: o", "Budget: run tokens left: no cap; money hold: no monthly cap", "## Waves", "### Wave 1", "- p1: given g; when w; then then-p1", "  owns: src/**", "  checks: npm test", "### Wave 2", "- p2: given g; when w; then then-p2", "  owns: src/**", "  checks: npm test"];
    expect(seen.on).toEqual({ stage: "execution", plan, commits: [[".agents/phases/<id>/PLAN.md"]] });
    expect(seen.off).toEqual({ stage: "execution", plan: null, commits: [] });
    expect(seen.noCommit).toEqual({ stage: "execution", plan, commits: [] });
  });

  it("[sma:k_wp_advance] an admitted plan moves the phase on by itself, to execution, or to the drawing first when the pieces build screens; a plan the gate refuses stays at planning and books nothing", async () => {
    const seen = await observeE.k_wp_advance();
    expect(seen.plain).toEqual({ stage: "execution", admitted: true, design: "not_needed", booked: ["admitted"] });
    expect(seen.screens).toEqual({ stage: "design", admitted: true, design: "needed", booked: ["admitted"] });
    expect(seen.refused).toEqual({ stage: "planning", admitted: false, design: null, booked: [] });
    expect(seen.unsigned).toEqual({ stage: "planning", admitted: false, design: null, booked: [] });
  });
});

describe("review, security and audit commands (n1276 … n1297)", () => {
  it("[sma:k_c_codereview] /sma-code-review reviews the range, writes the report and offers the fix workflow only when the review asks for rework", async () => {
    const seen = await observeE.k_c_codereview();
    expect(seen.rework.path).toBe("review report offer_fix done_offer");
    expect(seen.rework.out).toEqual({ status: "rework", proposed: "review-fix", high: 1, findings: [{ severity: "high", file: "src/search.ts", line: 22, evidence: "await missing" }] });
    expect(seen.pass.path).toBe("review report done");
    expect(seen.pass.out).toEqual({ status: "pass", proposed: null, warn: true });
  });

  it("[sma:k_c_crfix] code-review-fix plans and builds the fixes and reviews again; a second round only while the review still asks for rework, then the rest is classified for the owner and the run ends partial; a failed plan ends it without building", async () => {
    const seen = await observeE.k_c_crfix();
    expect(seen.one).toEqual({ path: "plan_fix build_fix re_review done", status: "done" });
    expect(seen.two).toEqual({ path: "plan_fix build_fix re_review plan_fix2 build_fix2 re_review done", status: "done" });
    expect(seen.spent).toEqual({ path: "plan_fix build_fix re_review plan_fix2 build_fix2 re_review classify ask partial", status: "partial", plans: 2, builds: 2, reviews: 2 });
    expect(seen.partialRemaining).toEqual([{ file: "src/a.ts" }]);
    expect(seen.noBuild).toEqual({ path: "plan_fix", status: "failed" });
  });

  it("[sma:k_c_secure] /sma-secure-phase ends in gaps naming the open threats and the register path, or in done when every threat is closed and the goal check holds", async () => {
    const seen = await observeE.k_c_secure();
    const path = ".agents/phases/ph_a/SECURITY.md";
    expect(seen.open).toEqual(["audit gaps", { status: "gaps", open: ["T1", "T2"], security_path: path }]);
    expect(seen.clean).toEqual(["audit goal_check done", { status: "done", open: [], security_path: path }]);
    expect(seen.unmet).toEqual(["audit goal_check gaps", "gaps"]);
  });

  it("[sma:k_c_validate] /sma-validate-phase ends in gaps naming the promises without a real check and the VALIDATION.md path, or in done", async () => {
    const seen = await observeE.k_c_validate();
    const path = ".agents/phases/ph_a/VALIDATION.md";
    expect(seen.gaps).toEqual(["audit gaps", { status: "gaps", gaps: ["p2: existence-only check"], validation_path: path }]);
    expect(seen.clean).toEqual(["audit goal_check done", { status: "done", gaps: [], validation_path: path }]);
    expect(seen.unmet).toEqual(["audit goal_check gaps", "gaps"]);
  });

  it("[sma:k_c_uireview] /sma-ui-review captures, scores and writes the review file unless switched off; a low score offers the fix workflow, an unscored one does not, and a capture that is blocked ends blocked", async () => {
    const seen = await observeE.k_c_uireview();
    expect(seen.ok).toEqual(["capture audit review_doc goal_check done", "done", 30, ["s375.png", "s1280.png"]]);
    expect(seen.noFile).toBe("capture audit goal_check done");
    expect(seen.low).toEqual(["capture audit review_doc goal_check offer done_offer", "review-fix"]);
    expect(seen.zero).toBe("capture audit review_doc goal_check done");
    expect(seen.blocked).toEqual(["capture blocked", "blocked"]);
  });

  it("[sma:k_c_evalreview] /sma-eval-review ends flawed with a todo offered when the evaluation has a flaw, sound with no offer otherwise, and flawed when the goal check fails", async () => {
    const seen = await observeE.k_c_evalreview();
    expect(seen.sound).toEqual(["review goal_check sound", "sound", null]);
    expect(seen.flawed).toEqual(["review offer flawed", "flawed", "todo-add", 1]);
    expect(seen.unmet).toEqual(["review goal_check flawed", "flawed"]);
  });

  it("[sma:k_c_audituat] /sma-audit-uat lists the open and failed acceptance lines of every phase from its UAT.md, writes the audit and offers a follow-up only when asked and something is open", async () => {
    const seen = await observeE.k_c_audituat();
    expect(seen.rows).toEqual(["a:open", "a:failed"]);
    expect(seen.asked).toEqual(["audit write goal_check offer done", 2]);
    expect(seen.nothing).toBe("audit write goal_check done");
    expect(seen.plain).toBe("audit write goal_check done");
  });
});
