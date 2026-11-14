// Region 0 (Phase graph), batch b: the plan hand-in, the drawing stage and the start of the execution (n30 … n58, n1768). Every test runs the real code of
// the node through tests/sma/r00-world-b.ts (the same observations the scene scripts/lp_drill/scenes/sma_r00_b.py proves) and checks the result the card names.
import { describe, expect, it } from "vitest";
import { observe } from "./r00-world-b";

const seen = <K extends keyof typeof observe>(name: K) => {
  const cache = (seen as unknown as { cache?: Map<string, Promise<unknown>> }).cache ??= new Map();
  if (!cache.has(name)) cache.set(name, Promise.resolve((observe[name] as () => unknown)()));
  return cache.get(name) as Promise<Awaited<ReturnType<(typeof observe)[K]>>>;
};

const AWAITS = "the drawing awaits the owner's word for this drawing: owner.words was on when the phase opened";
const NO_DRAWING = "no drawing: the designer draws the screens into the phase's design folder and names the files";
const NOT_REVIEWED = "the drawing is not reviewed by a separate role";
const SAME_ROLE = "the reviewer of the drawing is its designer: it must be a separate role";
const NO_FEASIBILITY = "no feasibility answer: feasible, or the contradiction with the plan";
const BASE = ["actions", "screens_states", "texts", "heuristics", "accessibility"];

describe("plan hand-in (n30 … n33)", () => {
  it("[sma:p2_parked] a blocking question is parked on the phase with its stage, written to the book, and holds the plan until it is answered; a soft one does not", async () => {
    const s = await seen("question");
    expect(s.stored).toEqual([["q1", "planning", true, "Which total?"], ["q2", "planning", false, "Which colour?"]]);
    expect(s.book).toEqual([["plan", "q1 (blocking): Which total?"], ["plan", "q2: Which colour?"]]);
    expect(s.whileOpen).toEqual(["open question q1: Which total?"]);
    expect(s.afterAnswer).toEqual([]);
  });

  it("[sma:p2_complete] the plan is handed in complete or it is not: the goal, three to five risks and a checker that approved are each named when missing", async () => {
    const s = await seen("planHandIn");
    expect(s.complete).toEqual([]);
    expect(s.noObjective).toEqual(["the plan names no objective: its goals in one line"]);
    expect(s.twoRisks).toEqual(["the plan names 2 pre-mortem risk(s): name three to five, each a likely cause of failure a week after merge"]);
    expect(s.noCheck).toEqual(["no independent plan check: run the plan critic (workflow lp.plan) and report its decision with the run's wfRunId"]);
    expect(s.changes).toEqual(["the plan checker asked for changes: split it"]);
  });

  it("[sma:p2_planning] a plan is composed of pieces whose task is the piece, its waves come from depends_on, its signature covers pieces and context; a goal already met is a plan with no pieces", async () => {
    const s = await seen("planComposition");
    expect(s.items).toEqual([["a", "a", 1], ["b", "b", 2]]);
    expect(s.shaCoversPiecesAndContext).toBe(true);
    expect(s.rounds).toBe(0);
    expect(s.book).toEqual(["plan <sha>: 2 piece(s) in 2 wave(s) — a (w1): t; b (w2): t"]);
    expect(s.notNeeded).toEqual({ pieces: 0, evidence: "the sum already skips blank cells", gate: [], book: 1 });
  });
});

describe("drawing start and the design decision (n34 … n39)", () => {
  it("[sma:p3_start] the machine starts the drawing at design while there is none and no design question is open, and at no other time", async () => {
    const s = await seen("drawStart");
    expect(s.due).toEqual({ kind: "draw" });
    expect(s.withDrawing).toBeNull();
    expect(s.openQuestion).toBeNull();
    expect(s.atPlanning).toBeNull();
    expect(s.paused).toBeNull();
  });

  it("[sma:p3_needs_plan] a drawing is taken only at design, after the plan is admitted: at planning it is refused and nothing is recorded; the admitted screen plan opens design", async () => {
    const s = await seen("admission");
    expect(s.atPlanning).toEqual({ refused: expect.stringMatching(/is at planning, not design$/), stage: "planning", parts: 0 });
    expect(s.afterAdmit).toEqual({ stage: "design", admitted: true, decision: "needed", why: "pieces that change screens: ui" });
    expect(s.afterDrawing).toBe("execution");
  });

  it("[sma:p3_requirements] a drawing must cover the five base sections, and the c4 and event chain for system or mixed work", async () => {
    const { requirements, mixedPlan, screen } = await seen("designDecisions");
    expect(requirements.screens).toEqual(BASE);
    expect(requirements.unset).toEqual(BASE);
    expect(requirements.system).toEqual([...BASE, "c4", "event_chain"]);
    expect(requirements.mixed).toEqual([...BASE, "c4", "event_chain"]);
    expect(screen.requirements).toEqual(BASE);
    expect(mixedPlan).toMatchObject({ mode: "mixed", requirements: [...BASE, "c4", "event_chain"] });
  });

  it("[sma:p3_needed] a drawing is needed when a piece changes a screen (a view file or a ui folder), or when the PM asks", async () => {
    const s = await seen("designDecisions");
    expect(s.screen).toMatchObject({ decision: "needed", why: "pieces that change screens: u" });
    expect(s.folder).toMatchObject({ decision: "needed", why: "pieces that change screens: p" });
    expect(s.style).toMatchObject({ decision: "needed", why: "pieces that change screens: s" });
    expect(s.oneOfTwo).toMatchObject({ decision: "needed", why: "pieces that change screens: u" });
    expect(s.asked).toMatchObject({ decision: "needed", why: "the PM asked for a drawing" });
  });

  it("[sma:p3_not_needed] no drawing is needed for a plan with no screen: the decision is recorded and the plan goes to the execution", async () => {
    const s = await seen("designDecisions");
    expect(s.logic).toEqual({ decision: "not_needed", why: "no piece changes a screen", mode: null, requirements: null });
    const admitted = await seen("admission");
    expect(admitted.plain).toEqual({ stage: "execution", decision: "not_needed", why: "no piece changes a screen", admitted: true });
  });

  it("[sma:p3_task] the drawing work carries the phase: its goal, folder, the sections it must cover and every piece's promise; with a planning home the folder is absolute", async () => {
    const s = await seen("drawStart");
    expect(s.inputs).toEqual({ goal: "sums are right", folder: ".agents/phases/ph_1", requirements: "actions, screens_states", material: false,
      pieces: "ui — ui: given an empty cell; when the sum runs; then it skips the cell (ui)" });
    expect(s.homeFolder).toBe("/abs/home/.agents/phases/ph_1");
  });
});

describe("the drawing and its checks (n40 … n52)", () => {
  it("[sma:p3_cmd] no field of the design command settles the question for the person: a report with the owner's word asked waits, only his keyed word confirms", async () => {
    const s = await seen("designWord");
    expect(s.accepts).toEqual({ plain: true, confirm: false, yes: false, owner: false });
    expect(s.afterReport).toEqual({ stage: "design", confirmedAt: null, gate: ["the drawing awaits the owner's word for this drawing: owner.words is on"] });
    expect(s.waiting).toEqual({ stage: "design", words: 0 });
    expect(s.afterWord).toEqual({ stage: "execution", confirmed: true });
  });

  it("[sma:p3_location] a drawing outside the phase's own design folder is refused with nothing recorded; inside it the drawing is kept", async () => {
    const s = await seen("drawingFolder");
    const own = "the drawing lives in its own folder .agents/phases/<id>/design/";
    expect(s.refused).toEqual({ "docs/fig.png": own, ".agents/phases/<id>/SPEC.md": own, ".agents/phases/<id>/design/../SECRET.md": own, "/etc/passwd": own });
    expect(s.beforeGood).toEqual({ stage: "design", drawing: null, parts: 0 });
    expect(s.good).toEqual({ stage: "execution", kept: [".agents/phases/<id>/design/UI-SPEC.md", ".agents/phases/<id>/design/kit.html"] });
  });

  it("[sma:p3_designer] the lp.draw stage reports the drawing under the designer role design-lead, drawn in the draw step of lp.draw", async () => {
    const s = await seen("drawStage");
    expect(s.designer).toBe("lp.draw: specialist design-lead");
    expect(s.roles.draw).toBe("specialist:design-lead");
    expect(s.gate).toEqual([]);
    expect(s.calls).toBe(1);
  });

  it("[sma:p3_ui_checker] the drawing is checked by another role (the plan critic of lp.draw's check step), the rework verdict reports no drawing, and the checker is never the designer", async () => {
    const s = await seen("drawStage");
    expect(s.reviewer).toBe("lp.draw: plan-critic");
    expect(s.roles.check).toBe("plan-critic");
    expect(s.reviewer).not.toBe(s.designer);
    expect(s.gate).toEqual([]);
    expect(s.rework).toMatchObject({ refused: true, calls: 1, designer: "lp.draw: specialist design-lead", reviewer: "lp.draw: plan-critic" });
  });

  it("[sma:p3_review] a drawing is held until a role other than its designer has reviewed it; the review time is the machine's, not a field of the report", async () => {
    const s = await seen("designReadiness");
    expect(s.noReviewer).toEqual([NOT_REVIEWED]);
    expect(s.sameRole).toEqual([SAME_ROLE]);
    expect(s.otherRole).toEqual([]);
    const t = await seen("reviewTime");
    expect(t).toEqual({ journaled: true, reviewer: "ui-review", designer: "design-lead", machineTime: true, reportAcceptsATime: false });
  });

  it("[sma:p3_advance] a redrawn drawing is a new edition: the previous one is archived with its hash and the person's earlier yes is voided", async () => {
    const s = await seen("edition");
    expect(s).toEqual({ yes: 1, stage: "design", redrawn: true, archived: [true], designWords: 0, asksAgain: true, book: [true] });
  });

  it("[sma:p3_feas_state] the drawing is held until the feasibility is answered, and is not held once it is", async () => {
    const s = await seen("designReadiness");
    expect(s.noFeasibility).toEqual([NO_FEASIBILITY]);
    expect(s.feasible).toEqual([]);
    expect(s.contradicts).not.toContain(NO_FEASIBILITY);
  });

  it("[sma:p3_feas_answer] the answer is «feasible» or a contradiction with its reason: the contradiction is booked and sends the phase back to planning, «feasible» goes on", async () => {
    const s = await seen("feasibility");
    expect(s.gate).toEqual(["the drawing contradicts the plan: no empty state — return the phase to planning"]);
    expect(s.back.stage).toBe("planning");
    expect(s.book[0]).toEqual(["drawing", ".agents/phases/<id>/design/UI-SPEC.md by design-lead; contradiction: the screen has no empty state; reviewed by ui-review"]);
    expect(s.feasible).toEqual({ stage: "execution", book: [".agents/phases/<id>/design/UI-SPEC.md by design-lead; feasible; reviewed by ui-review"] });
  });

  it("[sma:p3_awaiting] with the owner's word asked a reviewed, feasible drawing awaits it, and the phase's next step names that turn; with it not asked nothing awaits", async () => {
    const s = await seen("designReadiness");
    expect(s.asks).toBe(true);
    expect(s.doesNotAsk).toBe(false);
    expect(s.awaitsWord).toEqual([AWAITS]);
    expect(s.next).toEqual({ key: "design:word:design", waitsForPm: true });
    expect(s.wordForThisDrawing).toEqual([]);
    expect(s.wordForAnotherDrawing).toEqual([AWAITS]);
    expect(s.ready).toEqual([]);
  });

  it("[sma:p3_readiness] a drawing is ready only with the drawing, its contract with every required section, the answer, the review and no open design question; each missing part is named", async () => {
    const s = await seen("designReadiness");
    expect(s.ready).toEqual([]);
    expect(s.none).toEqual([NO_DRAWING]);
    expect(s.noContract).toEqual(["the drawing has no contract: add UI-SPEC.md with the checkable points (screens, states, breakpoints) to the drawing's paths"]);
    expect(s.missingSection).toEqual(["the drawing's contract misses required section(s): accessibility — UI-SPEC.md needs one heading per required section"]);
    expect(s.contractFull).toEqual([]);
    expect(s.openQuestion).toEqual(["open question q1: Which grid?"]);
    expect(s.otherStageQuestion).toEqual([]);
    expect(s.noFeasibility).toEqual([NO_FEASIBILITY]);
    expect(s.noReviewer).toEqual([NOT_REVIEWED]);
    expect(s.awaitsWord).toEqual([AWAITS]);
  });

  it("[sma:p3_confirm] the owner's yes at design names the hash of the drawing he was shown: without it or with another it is refused, with it the word is stored under its key", async () => {
    const s = await seen("designWord");
    const refused = /^the design yes names the hash of the drawing the owner was shown \(status ownerWord\.designKey, now [0-9a-f]{64}\)$/;
    expect(s.noKey).toMatch(refused);
    expect(s.wrongKey).toMatch(refused);
    expect(s.waiting.words).toBe(0);
    expect(s.word).toEqual({ decision: "yes", key: true, sha: true, by: "owner via screen" });
    expect(s.book).toEqual(["owner via screen: yes — да"]);
  });

  it("[sma:p3_confirmed] a reviewed, feasible drawing is confirmed at the moment it is reported; one with no review is not confirmed and stays at design", async () => {
    const s = await seen("confirmed");
    expect(s).toEqual({ unreviewed: "the drawing is not confirmed", heldStage: "design", heldConfirmed: null, stage: "execution", confirmedNow: true, reviewer: "ui-review" });
  });

  it("[sma:p3_back_to_plan] a drawing that contradicts the plan sends the phase back to planning: the plan is no longer admitted, the decision is cleared and the words are in the book", async () => {
    const s = await seen("feasibility");
    expect(s.back).toEqual({ stage: "planning", admittedSha: null, design: null, plan: 1 });
    expect(s.book[1]).toEqual(["return", "design → planning by design-lead: the drawing contradicts the plan: the screen has no empty state"]);
  });

  it("[sma:p3_judge] a drawing is scored by the rubric, criterion by criterion and width by width; the checker's scores and remarks are journaled apart from the drawing, pass or rework", async () => {
    const s = await seen("rubric");
    expect(s.oneWidth).toEqual({ score: 83, criteria: [["overflow", 0], ["contrast", 1], ["targets", 1], ["tiny_text", 1], ["one_h1", 1], ["spacing", 1]] });
    expect(s.twoWidths).toBe(92);
    expect(s.clean).toBe(100);
    expect(s.none).toBe(0);
    const d = await seen("drawStage");
    expect(d.critique).toEqual({ scores: { hierarchy: 3, spacing: 2, contrast: 3, states: 2 }, verdict: "pass", notes: "ok" });
    expect(d.rework.critique).toEqual({ scores: { hierarchy: 3, spacing: 2, contrast: 3, states: 2 }, verdict: "rework", notes: "redo the states" });
  });
});

describe("start of the execution (n53 … n58)", () => {
  it("[sma:p4_start] the execution is queued only by the phase's own step at the execution stage: not at design, not at planning, and the driver has no other door", async () => {
    const s = await seen("execution");
    expect(s.api.hasIssue).toBe(false);
    expect(s.atDesign).toEqual({ stage: "design", dispatched: 0, issued: [] });
    expect(s.atPlanning).toEqual({ stage: "planning", dispatched: 0, issued: [] });
    expect(s.first.stage).toBe("execution");
    expect(s.first.tasks).toEqual(["a"]);
  });

  it("[sma:p4_plan_gate] the plan is issued only as the edition that was checked: a plan changed after admission is refused and nothing is issued", async () => {
    const s = await seen("execution");
    expect(s.edited).toEqual({ refused: "the plan changed since it was checked: return the phase to planning", dispatched: 0, issued: {} });
    expect(s.first.issued).toEqual({ a: "task-a" });
  });

  it("[sma:p4_design_ready] the execution starts when the drawing is not needed or is ready, and not before: a needed drawing that is missing or not reviewed holds it", async () => {
    const s = await seen("designDoor");
    expect(s.notNeeded).toEqual([]);
    expect(s.ready).toEqual([]);
    expect(s.needed).toEqual([NO_DRAWING]);
    expect(s.unreviewed).toEqual([NOT_REVIEWED]);
    expect(s.undecided).toEqual(["the design decision is not made"]);
    const a = await seen("admission");
    expect(a.afterAdmit.stage).toBe("design");
    expect(a.plain.stage).toBe("execution");
  });

  it("[sma:p4_base] the base of the phase is the base of its first piece, fixed at the first issue and kept by later passes", async () => {
    const s = await seen("phaseRow");
    expect(s.base).toBe("1".repeat(40));
    expect(s.baseAfterAnotherPass).toBe("1".repeat(40));
  });

  it("[sma:p4_row] the phase row carries its address (the run the pieces went to), its edition, the drawing and the base", async () => {
    const s = await seen("phaseRow");
    expect(s.row).toEqual({ id: true, runId: "run9", stage: "execution", editionGrew: true, issued: { a: "task-a", b: "task-b" }, startedAt: "number", drawing: [".agents/phases/<id>/design/UI-SPEC.md"] });
    expect(s.firstPieceBase).toBe(true);
  });

  it("[sma:p4_issue] each plan piece is issued as its own work, a piece after the pieces it depends on, and the issue is written to the book", async () => {
    const s = await seen("execution");
    expect(s.first.issued).toEqual({ a: "task-a" });
    expect(s.first.ownTaskId).toBe("a");
    expect(s.first.quality).toBe("full");
    expect(s.first.plan).toMatch(/, wave 1, piece a\. Promise/);
    expect(s.book).toEqual(["a → task task-a (wave 1)"]);
  });
});
