// Region 0 (Phase graph), batch d: acceptance, landing, closure, the rollback watch and the lessons trigger (n90 … n119). Each test takes the card's input and checks the result the card
// names — a line's verdict and its words, the record the phase was left with, the book part, the stage it went to — on the real code (observations in tests/sma/r00-world-d.ts).
// n103, n105, n110 (the phase candidate and its landing) and n113 (the rollback watch) keep their existing tests in tests/phase-candidate.test.ts and tests/sma/parity-a2-phase.test.ts.
import { describe, expect, it } from "vitest";
import { observe } from "./r00-world-d";

const NOT_ASKED = "this phase's acceptance does not ask for the owner's word (owner.words: not in money, data or production deploy, or off)";

describe("region 0 · the UAT lines and the package", () => {
  it("[sma:p5_uat_line] a person answers a UAT line by its number: an unknown number is refused, one answer changes that line alone, and the session word waits for every line", async () => {
    const s = await observe.uatLine();
    expect(s.refused).toBe("no UAT line 4: the lines are 1 to 3");
    expect(s.afterFail).toEqual([[1, "p1", "open", null], [2, "p2", "failed", "the bar is missing"], [3, "p3", "open", null]]);
    expect(s.early).toBe("UAT is not complete: 2 open, 1 failed of 3 — the owner answers each line by its number (uat_line)");
    expect(s.afterPass).toEqual([[1, "p1", "passed", null], [2, "p2", "passed", null], [3, "p3", "passed", null]]);
    expect(s.word).toBe("uat");
    expect(s.booked).toEqual(["UAT line 2 (p2): fail — the bar is missing by owner", "UAT line 2 (p2): pass by owner", "UAT line 1 (p1): pass by owner", "UAT line 3 (p3): pass by owner"]);
  });

  it("[sma:p5_record_after] the UAT record lands on main only after the phase landed: before it the answers live in the record, after it the file is written once with them", async () => {
    const s = await observe.recordAfter();
    expect(s.early).toEqual({ lines: 1, sha: "", writes: 0 });
    expect(s.after).toEqual({ writes: 1, text: "- [x] 1. p1: given an empty cell, when the sum runs, then it skips the cell (p1)", sha: true });
  });

  it("[sma:p6_package] the package the person decides on is the key, the frozen verdict and the diffstat of the work — only at acceptance and only with a verdict", async () => {
    const s = await observe.acceptancePackage();
    expect(s.shown).toEqual({ key: s.key, verdict: { state: "passed", detail: "every piece accepted and proved", mainSha: "b".repeat(40) }, diffStat: "a".repeat(40) });
    expect(s.key).toMatch(/^[0-9a-f]{16}$/);
    expect(s.wrongStage).toBeNull();
    expect(s.noVerdict).toBeNull();
  });

  it("[sma:p6_composition] a changed record is a new edition of the phase, the same record is not", async () => {
    const s = await observe.editions();
    expect(s).toEqual({ start: 2, afterChange: 3, afterSame: 3, afterStage: 3, afterSecond: 4 });
  });
});

describe("region 0 · the acceptance calculation, line by line", () => {
  it("[sma:p6_calc] the lines are decided by code from the phase's facts: a stored claim improves nothing, one worse fact worsens exactly its own line, the goal audit is read as it is", () => {
    const s = observe.lineCalc();
    expect(s.green).toEqual([]);
    expect(s.claimedRed).toEqual(["checks_passed"]);
    expect(s.claimedDetail).toEqual({ ok: false, detail: "checks failed: a" });
    expect(s.goal).toEqual({ ok: true, detail: "audit: the goal is met" });
    expect(s.noAudit).toEqual({ ok: false, detail: "no goal audit yet" });
    expect(s.unmet).toEqual({ ok: false, detail: "audit: the cart is still hidden" });
  });

  it("[sma:p6_evidence] the browser evidence is read as it is: failed, planned and not passed, a live check on another head are red; passed and not owed say so", () => {
    const s = observe.qaRead();
    expect(s.none).toEqual({ ok: true, detail: "0 piece(s) passed their browser check; 1 piece(s) plan none (no qa_cases)" });
    expect(s.failed).toEqual({ ok: false, detail: "the browser check failed: a" });
    expect(s.owed).toEqual({ ok: false, detail: "the planned browser check has not passed: a" });
    expect(s.passed).toEqual({ ok: true, detail: "1 piece(s) passed their browser check" });
    expect(s.stale).toEqual({ ok: false, detail: `the live check was taken on head ${"b".repeat(12)}, the package it decides on is at ${"a".repeat(12)} — check the same candidate` });
  });

  it("[sma:p6_l_contract] the judged edition is the confirmed one: green on the admitted plan, red with its words when the plan changed or was never admitted", () => {
    const s = observe.contractLine();
    expect(s.current).toEqual({ ok: true, detail: "the plan is the admitted one" });
    expect(s.changed).toEqual({ ok: false, detail: "the plan changed after its admission" });
    expect(s.neverAdmitted).toEqual({ ok: false, detail: "the plan changed after its admission" });
  });

  it("[sma:p6_l_promise] each promise has a plan-fact receipt: the line names the pieces that have none or failed", () => {
    const s = observe.promiseLine();
    expect(s.proved).toEqual({ ok: true, detail: "2 promises proved" });
    expect(s.oneFailed).toEqual({ ok: false, detail: "not proved by plan-fact: b" });
    expect(s.noReceipt).toEqual({ ok: false, detail: "not proved by plan-fact: a" });
  });

  it("[sma:p6_l_regression] the daemon's own checks decide: every piece's checks passed, or the line names the pieces whose checks failed (and no other line moves)", () => {
    const s = observe.checksLine();
    expect(s.passed).toEqual({ ok: true, detail: "every piece's checks passed" });
    expect(s.oneFailed.checks_passed).toEqual({ ok: false, detail: "checks failed: b" });
    expect(Object.entries(s.oneFailed).filter(([, line]) => !line.ok).map(([id]) => id)).toEqual(["checks_passed"]);
    expect(s.bothFailed).toEqual({ ok: false, detail: "checks failed: a, b" });
  });

  it("[sma:p6_l_verdict] the independent check admits only on a positive receipt: a blocking critic, no receipt and a skipped one are red, each in its own words", () => {
    const s = observe.criticLine();
    expect(s.passed).toEqual({ ok: true, detail: "the code critic passed all 1 piece(s)" });
    expect(s.blocked).toEqual({ ok: false, detail: "the code critic blocks: a" });
    expect(s.noReceipt).toEqual({ ok: false, detail: "the code critic has not passed: a (no critic receipt is no reading)" });
    expect(s.skipped).toEqual(s.noReceipt);
  });

  it("[sma:p6_l_landing] the landing tree is prepared: every piece merged into main or into the phase candidate, otherwise the line names the pieces that are not", () => {
    const s = observe.landedLine();
    expect(s.main).toEqual({ ok: true, detail: "every piece is merged into main" });
    expect(s.oneNot).toEqual({ ok: false, detail: "not merged: b" });
    expect(s.bothNot).toEqual({ ok: false, detail: "not merged: a, b" });
    expect(s.candidate).toEqual({ ok: true, detail: "every piece is merged into the phase candidate phase/ph_1" });
  });

  it("[sma:p6_l_useful] «the result is clear and useful» is a person's decision under the shown key: the yes on «useful» opens it and does not open «limits»", () => {
    const s = observe.usefulLine();
    expect(s.notAsked).toEqual({ ok: true, detail: NOT_ASKED });
    expect(s.waiting).toEqual({ ok: false, detail: "awaits the owner's keyed decision" });
    expect(s.usefulOnly.useful).toEqual({ ok: true, detail: "owner: yes — the result is clear and useful — да" });
    expect(s.usefulOnly.limits.ok).toBe(false);
    expect(s.limitsOnly.useful.ok).toBe(false);
    expect(s.no).toEqual({ ok: false, detail: "owner: no — not yet" });
  });

  it("[sma:p6_l_limits] the limits are acknowledged by a person after every put-off check has its term: a check with no term holds the line whatever was said", () => {
    const s = observe.limitsLine();
    expect(s.notAsked).toEqual({ ok: true, detail: `nothing deferred; ${NOT_ASKED}` });
    const held = { ok: false, detail: "1 deferred check(s) of this project are open with no term from the owner, so they count as unproven: def-1 — close each with evidence (bb lane-pilot defer-close <id> --evidence …)" };
    expect(s.noTermNotAsked).toEqual(held);
    expect(s.noTermAsked).toEqual(held);
    expect(s.openAsked).toEqual({ ok: true, detail: "2 deferred item(s) of this project stay open, named in the book; owner: yes — the limits are acknowledged — да" });
    expect(s.waiting).toEqual({ ok: false, detail: "nothing deferred; awaits the owner's keyed decision" });
  });

  it("[sma:p6_authorized] a person authorizes this very phase package: the yes under the shown key opens both person lines; another key, no key, a «no» and silence do not", () => {
    const s = observe.authorized();
    expect(s.shown.useful.ok && s.shown.limits.ok).toBe(true);
    expect(s.otherPackage.useful).toEqual({ ok: false, detail: "the owner's word was given on another package (0123456789abcdef): it is asked again" });
    expect(s.noKey.useful).toEqual({ ok: false, detail: "the owner's word was given on another package (no key): it is asked again" });
    expect(s.no.useful).toEqual({ ok: false, detail: "owner: no — not yet" });
    expect(s.none.useful).toEqual({ ok: false, detail: "awaits the owner's keyed decision" });
    expect(s.none.limits.ok).toBe(false);
  });

  it("[sma:p6_decide] the key of the package is sixteen hex characters; the plan, the verdict's input, the tree it saw and the drawing each make a new key, nothing else does", () => {
    expect(observe.key()).toEqual({ shape: true, same: true, plan: true, input: true, tree: true, drawing: true, redrawn: true, contract: true, unrelated: true });
  });

  it("[sma:p6_closure] the closure is by completeness: a requirement or a locked decision no piece carries out holds the close — also after a withdrawal; full coverage and «already met» close it", () => {
    const s = observe.closure();
    expect(s.covered).toEqual({ ok: true, detail: "every requirement and locked decision is covered" });
    const gaps = "left uncovered at close: requirements no piece covers: r2 (name them in a piece's covers, or defer them in CONTEXT.md and sign again); locked decisions no piece carries out: d1";
    expect(s.uncovered).toEqual({ ok: false, detail: gaps });
    expect(s.afterWithdraw).toEqual({ ok: false, detail: gaps });
    expect(s.notMet.ok).toBe(false);
    expect(s.alreadyMet.ok).toBe(true);
    expect(s.none.ok).toBe(true);
  });
});

describe("region 0 · closing, the watch and the lessons", () => {
  it("[sma:p6_stale] a main that moved since the verdict sends the phase back to verification with no verdict and no acceptance, so a new word is asked on the new package", async () => {
    const s = await observe.mainMoved();
    expect(s.same).toEqual({ stage: "acceptance", verdict: "passed" });
    expect(s.moved).toEqual({ stage: "verification", verification: null, acceptance: null });
    expect(s.stages).toEqual(["acceptance → verification: main moved since the verdict: verified again"]);
  });

  it("[sma:p6_file_closed] the book is closed only after its documents read back as written: a read that differs keeps the phase open and says so, an intact read closes it", async () => {
    const s = await observe.closingDocs();
    expect(s.files).toEqual(["SUMMARY.md", "BOOK.md"]);
    expect(s.open.state).toBe("active");
    expect(s.open.closedDocs).toBeNull();
    expect(s.open.said).toHaveLength(1);
    expect(s.open.said[0]).toMatch(/^closing docs not confirmed: \.agents\/phases\/ph_\w+\/SUMMARY\.md, \.agents\/phases\/ph_\w+\/BOOK\.md did not read back as written$/);
    expect(s.open.concluded).toBe(0);
    expect(s.closed.state).toBe("closed");
    expect(s.closed.closedDocs).toBe(true);
    expect(s.closed.concluded).toEqual(["SUMMARY.md written, .agents/planning/STATE.md marked (commit cccccccccccc)"]);
    expect(s.closed.said).toBe(1);
  });

  it("[sma:p6_withdrawal] a withdrawal is agreed: an unissued piece leaves with its note and the plan is admitted again as it now is; an issued or unknown piece is refused", async () => {
    const s = await observe.withdrawal();
    expect(s.issued).toBe("issued pieces are canceled, not withdrawn");
    expect(s.unknown).toMatch(/^no piece gone in the plan of phase ph_\w+: nothing is changed$/);
    expect(s.left).toEqual(["keep", "more"]);
    expect(s.withdrawn).toEqual(["drop"]);
    expect(s.readmitted).toBe(true);
    expect(s.book).toEqual(["drop withdrawn by owner: the owner dropped it"]);
  });

  it("[sma:p6_observe_out] the observation outcome: a revert is a failure, nothing readable is no data, an open window is incomplete, the first pass after the window ends the watch", () => {
    const s = observe.outcome();
    const until = 7 * 86_400_000;
    expect(s.failure).toEqual({ outcome: "failure", reverted: ["p1 (task t)"], until });
    expect(s.noData).toEqual({ outcome: "no_data", reverted: [], until });
    expect(s.incomplete).toEqual({ outcome: "incomplete", reverted: [], until });
    expect(s.atEnd).toEqual({ outcome: "no_failure", reverted: [], until });
    expect(s.after).toEqual({ outcome: "no_failure", reverted: [], until });
    expect(s.lateFailure).toEqual({ outcome: "failure", reverted: ["p1"], until });
  });

  it("[sma:p7_events] each outcome of the phase is counted from its own record: a return, a failed attempt and a failed verdict (never a passed one) are what the analysis is asked for", async () => {
    const s = await observe.outcomes();
    expect(s.returned.lessons).toEqual({ needed: true, why: "1 return(s) to an earlier stage" });
    expect(s.attempt.lessons).toEqual({ needed: true, why: "1 failed attempt(s)" });
    expect(s.failedVerdict.lessons).toEqual({ needed: true, why: "1 failed verdict(s)" });
    expect(s.all.lessons).toEqual({ needed: true, why: "1 return(s) to an earlier stage, 1 failed attempt(s), 1 failed verdict(s)" });
  });

  it("[sma:p7_calc] an analysis is needed after a return, a failed attempt or a failed verdict — each alone — and the reasons are said together", () => {
    const s = observe.calc();
    expect(s.none).toEqual({ needed: false, why: "the phase went through without returns or failures" });
    expect(s.returns).toEqual({ needed: true, why: "1 return(s) to an earlier stage" });
    expect(s.attempts).toEqual({ needed: true, why: "2 failed attempt(s)" });
    expect(s.verdicts).toEqual({ needed: true, why: "3 failed verdict(s)" });
    expect(s.all).toEqual({ needed: true, why: "1 return(s) to an earlier stage, 2 failed attempt(s), 3 failed verdict(s)" });
  });

  it("[sma:p7_no_trigger] a phase that went straight through closes with no analysis and the reason booked; a phase with a trigger goes to lessons and books nothing", async () => {
    const s = await observe.outcomes();
    expect(s.straight).toEqual({ stage: "closed", lessons: { needed: false, why: "the phase went through without returns or failures" }, none: ["the phase went through without returns or failures"], booked: 0 });
    for (const trigger of [s.returned, s.attempt, s.failedVerdict, s.all]) { expect(trigger.stage).toBe("lessons"); expect(trigger.none).toEqual([]); }
  });

  it("[sma:p7_pass] the lessons pass every tick: a phase at lessons with a run and no analysis is due for one; with an analysis, no run, spent tries or off the active state it is not", () => {
    expect(observe.pass()).toEqual({ due: "lessons", analysed: null, noRun: null, tried: null, paused: null, execution: true });
  });

  it("[sma:p7_pending] the analysis awaits a worker: the PM is told to run the retrospective under the key «analysis»; with the analysis written nothing waits", () => {
    const s = observe.pending();
    expect(s.waiting).toEqual({ key: "lessons:analysis", waitsForPm: true, text: "Phase ph_1 «Sums» — stage 7, lessons (1 return(s) to an earlier stage). Run the retrospective (workflow retrospective) o", asks: true });
    expect(s.written).toEqual({ key: "lessons:written", waitsForPm: false });
  });
});
