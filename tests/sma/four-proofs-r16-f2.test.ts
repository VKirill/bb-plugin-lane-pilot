// Region 16 (slash commands and workflows), batch f, second half: the discussion stage (n1315 … n1327), ship and the clean PR branch (n1328, n1329).
// Every test runs the real code of the node through tests/sma/r16-world-f.ts (the same observations the scene scripts/lp_drill/scenes/sma_r16_f.py proves) and checks the result the
// card names: the order and antipatterns the PM is given, what the stage reads, what CONTEXT.md holds, what is committed, where the phase stands after the signature, what a gate holds.
import { describe, expect, it } from "vitest";
import { observeF } from "./r16-world-f";

const ORDER = ["read the goal and the roadmap row", "scout the code the goal touches", "list the gray areas and pick the ones to settle", "deep-dive each chosen area (one advisor per area)", "write CONTEXT.md: locked / free / deferred, FAQ, ADR", "name the four risks", "sign the context"];
const ANTI = ["deciding for the owner what only he knows", "a decision without its reason", "a free area written as locked", "risks left unnamed"];

describe("the discussion stage rubric and its reads (n1315 … n1318)", () => {
  it("[sma:k_wdi_rubric] the stage order is set here: the seven stages in their order, and the PM is given the discussion's seven steps whole, by stage or by phase", async () => {
    const seen = await observeF.k_wdi_rubric();
    expect(seen.stages).toEqual(["discussion", "planning", "design", "execution", "verification", "acceptance", "lessons"]);
    expect(seen.phaseStages).toEqual(seen.stages);
    expect(seen.order).toEqual(ORDER);
    expect(seen.same).toBe(true);
    expect(seen.line).toBe(`Order of work: ${ORDER.map((step, index) => `${index + 1}) ${step}`).join("; ")}.`);
  });

  it("[sma:k_wdi_init] before the discussion the PM reads the roadmap, the requirements and the discussion file, in that order; a closed phase reads only its book", () => {
    const seen = observeF.k_wdi_init();
    expect(seen.discussion).toEqual([".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md", ".agents/phases/ph_sma/DISCUSSION.md"]);
    expect(seen.signedDiscussion).toEqual(seen.discussion);
    expect(seen.closed).toEqual([".agents/phases/ph_sma/BOOK.md"]);
  });

  it("[sma:k_wdi_anti] the four antipatterns that block the discussion are given with the order, and the stage line the PM reads ends with them in the same words", async () => {
    const seen = await observeF.k_wdi_anti();
    expect(seen.antipatterns).toEqual(ANTI);
    expect(seen.line).toBe(`${ANTI.join("; ")}.`);
  });

  it("[sma:k_wdi_spec] a clarified «what» is written down and not asked again: the signed context becomes SPEC.md with the goal, requirements, locked decisions, appetite and no-gos, and planning reads it right after the context documents", async () => {
    const seen = await observeF.k_wdi_spec();
    expect(seen.written).toEqual(["<!-- lp:generated -->", "# Spec — phase <id>: Hud", "", "Goal: a hud for the stats page", "", "Ambiguity: 0", "", "## Requirements", "- R1", "", "## Locked decisions", "- D1"]);
    expect(seen.planning).toEqual([".agents/phases/ph_sma/CONTEXT.md", ".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/RESEARCH.md", ".agents/phases/ph_sma/PATTERNS.md"]);
    expect(seen.text).toEqual(["# Spec — phase ph_sma: Hud", "", "Goal: a hud", "", "## Requirements", "- R1", "", "## Locked decisions", "- D1", "- D2", "", "## Appetite", "one wave", "", "## No-gos", "- pdf", ""]);
  });
});

describe("the analysis behind the discussion (n1319 … n1325)", () => {
  it("[sma:k_wdi_existing] a CONTEXT.md that exists is found and its decisions are kept under «Earlier decisions (kept)» with a line in the book; without one the new document stands alone", async () => {
    const seen = await observeF.k_wdi_existing();
    expect(seen.kept.tail).toEqual(["## Earlier decisions (kept)", "", "D1: keep this decision always", ""]);
    expect(seen.kept.booked).toEqual(["context_existing: an existing CONTEXT.md was found (29 chars): its text is kept under «Earlier decisions (kept)» in the new one"]);
    expect(seen.fresh).toEqual({ has: false, booked: [] });
  });

  it("[sma:k_wdi_scout] the code is scouted before any question: the scout runs first and read-only, its anchors reach the result, and a thin assessment sends the scout round again", async () => {
    const seen = await observeF.k_wdi_scout();
    expect(seen.path).toBe("gather assess done");
    expect(seen.anchors).toEqual([{ file: "src/stats.ts", line: 12, note: "the table" }]);
    expect(seen.again).toEqual(["gather assess gather assess done", 2]);
    expect(seen.role).toBe("analyst");
    expect(seen.readOnly).toBe(true);
  });

  it("[sma:k_wdi_gray] the person picks which gray areas to settle: the chosen ones are discussed and the rest are deferred and marked in CONTEXT.md; without ask_owner (or without open questions) the choice is not visited", async () => {
    const seen = await observeF.k_wdi_gray();
    expect(seen.asked).toEqual(["gather assess choose advise done", ["cache?"]]);
    expect(seen.plain).toEqual(["gather assess done", 0]);
    expect(seen.noQuestions).toEqual(["gather assess choose advise done", ["choose", "advise:fan", "advise"]]);
    expect(seen.marked).toEqual(["- auth?", "- cache? — deferred by the owner"]);
  });

  it("[sma:k_wdi_deep] the deep-dive goes on until clear: a low assessment sends the scout round again (three assessments at most) and each chosen area gets one advisor, as the rubric says", async () => {
    const seen = await observeF.k_wdi_deep();
    expect(seen.step).toBe("deep-dive each chosen area (one advisor per area)");
    expect(seen.advisors).toBe(3);
    expect(seen.loop).toEqual(["gather assess gather assess gather assess done", 3]);
  });

  it("[sma:k_wdi_advisor] with a developer profile an advisor compares the options of each area, at most six (the rest are cut, the run does not fail); without a profile no advisor runs and the advice is empty", async () => {
    const seen = await observeF.k_wdi_advisor();
    expect(seen.profile).toEqual(["gather assess choose advise done", 2, 2]);
    expect(seen.bare).toEqual([0, []]);
    expect(seen.wide).toEqual(["succeeded", 6]);
    expect(seen.fanOut).toBe(6);
  });

  it("[sma:k_wdi_write] CONTEXT.md is written by the machine from the analysis: each decision is locked, free or deferred (locked when nothing says), numbered when it has no id, with appetite, no-gos, risks and open questions; the rubric names the step", async () => {
    const seen = await observeF.k_wdi_write();
    expect(seen.step).toBe("write CONTEXT.md: locked / free / deferred, FAQ, ADR");
    expect(seen.decisions).toEqual(["- **D1** (locked): reuse the table", "- **D2** (free): the chart library", "- **D3** (deferred): pdf export", "- **D4** (locked): no id and no status"]);
    expect(seen.ids).toEqual(["D1", "D2", "D3", "D4"]);
    expect(seen.head).toEqual(["# Context — Sum", "", "Goal: sums", ""]);
    expect(seen.sections).toEqual(["## Appetite", "## Decisions", "## No-gos", "## Risks", "## Open questions"]);
  });
});

describe("the end of the discussion (n1326, n1327)", () => {
  it("[sma:k_wdi_commit] the decisions are committed and the state is marked: CONTEXT.md (with SECURITY.md when a security risk is named) goes in one commit of exactly those files, STATE.md follows the move to planning, and a project that does not commit docs gets the files and no commit", async () => {
    const seen = await observeF.k_wdi_commit();
    expect(seen.plain).toEqual({ commits: [{ files: ["CONTEXT.md"], message: "phase <id>: CONTEXT.md from the analysis" }], written: true });
    expect(seen.secure).toEqual({ commits: [{ files: ["CONTEXT.md", "SECURITY.md"], message: "phase <id>: CONTEXT.md and SECURITY.md from the analysis" }], security: "# Threat model — Hud" });
    expect(seen.quiet).toEqual({ commits: [], written: true });
    expect(seen.signed.commits).toEqual([{ files: ["SPEC.md"], message: "phase <id>: SPEC.md" }, { files: ["STATE.md"], message: "phase <id>: STATE.md at planning" }]);
    expect(seen.signed.state).toEqual(['phase: "1"', 'stage: "planning"', "## Position", "- stage planning", "## Decisions", "## Blockers"]);
  });

  it("[sma:k_wdi_advance] a signed context moves the phase to planning at once; with the owner's word asked the signature waits at discussion for it", async () => {
    const seen = await observeF.k_wdi_advance();
    const signed = "signed: context signed <sha>: .agents/phases/<id>/CONTEXT.md (46 B); appetite — one wave; no-gos — none; risks — value: v; usability: u; feasibility: f; viability: b";
    expect(seen.auto).toEqual(["planning", "planning", [signed, "stage: discussion → planning: the context documents exist, none is empty, and they are signed"]]);
    expect(seen.asked).toEqual(["discussion", "discussion", true, [signed, "awaits_signature: the context is complete and awaits the owner's signature (his word «context»)"]]);
  });
});

describe("ship and the clean PR branch (n1328, n1329)", () => {
  it("[sma:k_c_ship] the gates stand before the PR: a red integration gate, a missing preflight item or a review asking for rework hold the ship and say by what; a ready phase opens the PR from its artifacts and runs the hooks, a failed hook is listed", async () => {
    const seen = await observeF.k_c_ship();
    expect(seen.shipped).toEqual(["gate preflight review_range review open_pr write_deploy_log state_mark hooks post_ship goal_check shipped", { status: "shipped", pr_url: "https://example/pr/7", held_by: [], hooks_failed: ["tag"] }]);
    expect(seen.skippedReview).toBe(true);
    expect(seen.gate).toEqual(["gate held_gate", { status: "held", pr_url: "", held_by: ["npm test red on the head"], hooks_failed: [] }]);
    expect(seen.held).toEqual(["gate preflight held", { status: "held", pr_url: "", held_by: ["no full-gate marker", "untriaged vendor bump"], hooks_failed: [] }, 0]);
    expect(seen.reviewed).toEqual(["gate preflight review_range review held_review", "held", 0]);
  });

  it("[sma:k_c_prbranch] the PR branch is review/<phase> without the planning bookkeeping commits; a conflict stops it as blocked and still names the branch", async () => {
    const seen = await observeF.k_c_prbranch();
    expect(seen.clean).toEqual(["split done", { status: "done", branch: "review/ph_a", commits: 3 }]);
    expect(seen.conflict).toEqual(["split blocked", { status: "blocked", branch: "review/ph_a", commits: 1 }]);
    expect(seen.drops).toBe(true);
    expect(seen.stops).toBe(true);
  });
});
