// Region 0 (Phase graph), batch c: execution by plans and the phase's own verification (n59 … n89). Every test runs the real code of the node through
// tests/sma/r00-world-c.ts (the same observations the scene scripts/lp_drill/scenes/sma_r00_c.py proves) and checks the result the card names.
import { describe, expect, it, vi } from "vitest";
import { getBaseline } from "../../src/rooms/baseline";
import { git } from "../verification/git-integrate-helpers";
import { world } from "../baseline/world";
import { H, M, observe } from "./r00-world-c";

const seen = <K extends keyof typeof observe>(name: K) => {
  const cache = (seen as unknown as { cache?: Map<string, Promise<unknown>> }).cache ??= new Map();
  if (!cache.has(name)) cache.set(name, Promise.resolve((observe[name] as () => unknown)()));
  return cache.get(name) as Promise<Awaited<ReturnType<(typeof observe)[K]>>>;
};

const NO_RECEIPT = "plan-fact left no receipt — its acceptance items were not checked against the diff";

describe("the plan as work (n59 … n66)", () => {
  it("[sma:p4_plan_file] the plan is the edition that was checked: the same hash is unchanged, a rewrite is not, and a rewritten plan is neither issued nor accepted", async () => {
    const s = await seen("planFile");
    expect(s.unchanged).toBe(true);
    expect(s.unchangedLine).toEqual({ ok: true, detail: "the plan is the admitted one" });
    expect(s.rewritten).toEqual({ unchanged: false, line: { ok: false, detail: "the plan changed after its admission" }, refused: "the plan changed since it was checked: return the phase to planning", dispatched: 0 });
    // The pieces edited and the signature left as it was: the hash recomputed from the pieces is not the admitted one.
    expect(s.edited).toBe(false);
  });

  it("[sma:p4_piece] a plan piece goes out as a work piece: its own contract, the fields the machine knows itself filled in, its promise, no browser case without a url", async () => {
    const s = await seen("pieceContract");
    expect(s.bare).toEqual({ display_title: "Skeleton view", kind: "feature", area: "phase:ph_1/p1", promise: { given: "an empty cell", when: "the sum runs", then: "it skips the cell (p1)" }, qa_cases: null, dropped: null });
    expect(s.own).toEqual({ display_title: "Own title", kind: "fix", area: "billing", promise: { given: "x", when: "y", then: "z" }, qa_cases: null, dropped: null });
    expect(s.withCases).toMatchObject({ area: "phase:ph_1/p3", qa_cases: null, dropped: "p3: 1 browser case(s) dropped at issue: no qa_url to run them on; the piece's verification stays its proof" });
    expect(s.withUrl).toMatchObject({ area: "phase:ph_1/p4", qa_cases: ["opens"], dropped: null });
    expect(s.sent).toEqual({ id: "p1", display_title: "Skeleton view", kind: "feature", area: "phase:<id>/p1", promise: { given: "an empty cell", when: "the sum runs", then: "it skips the cell (p1)" },
      objective: "Skeleton   view: given an empty cell, when the sum runs, then it skips the cell (p1)", owns_paths: ["src/p1.ts"], verification: [{ command: "npm test -- p1" }], acceptance: ["works"] });
  });

  it("[sma:p4_binding] the binding of a piece and its work is written on the phase: the task, the contract print and the run; it is issued once and again only when its contract changed", async () => {
    const s = await seen("binding");
    expect(s.afterFirst).toEqual({ dispatched: 1, issued: { a: "a" }, printIsPiece: true, runId: "run1", book: ["a → task a (wave 1)"] });
    expect(s.again).toEqual({ dispatched: 1, issued: { a: "a" } });
    expect(s.changed).toEqual({ dispatched: 2, secondId: "a.2", issued: { a: "a.2" }, printIsNewPiece: true, reissued: ["a: its contract changed since a — issued again as a.2"] });
  });

  it("[sma:p4_wave_addr] the wave is the piece's address: the earliest wave is issued first, each issue line, wave table and plan text names its wave", async () => {
    const s = await seen("waveAddress");
    expect(s.waves).toEqual([1, 2]);
    expect(s.wave1).toEqual(["b"]);
    expect(s.wave2).toEqual(["a", "c"]);
    expect(s.order).toEqual(["b", "a", "c"]);
    expect(s.issued).toEqual(["b → task b (wave 1)", "a → task a (wave 2)", "c → task c (wave 2)"]);
    expect(s.firstLines).toEqual([
      "Phase <id> «Hud», wave 1, piece b. Promise — given an empty cell; when the sum runs; then it skips the cell (b).",
      "Phase <id> «Hud», wave 2, piece a. Promise — given an empty cell; when the sum runs; then it skips the cell (a).",
      "Phase <id> «Hud», wave 2, piece c. Promise — given an empty cell; when the sum runs; then it skips the cell (c).",
    ]);
    expect(s.tables).toEqual([
      ["wave 1:", "| piece | task | promise |", "|---|---|---|", "| b | b | it skips the cell (b) |"],
      ["wave 2:", "| piece | task | promise |", "|---|---|---|", "| a | a | it skips the cell (a) |", "| c | c | it skips the cell (c) |"],
    ]);
  });

  it("[sma:p4_drawing] a piece that builds screens carries the phase drawing in its task and its plan text; a piece that builds none carries none", async () => {
    const s = await seen("drawingInPiece");
    const paths = [".agents/phases/ph_1/design/UI-SPEC.md", ".agents/phases/ph_1/design/kit.html"];
    expect(s.sentDrawing).toEqual([["ui", paths], ["a", null]]);
    expect(s.planLines).toEqual([["ui", [`   the screens follow the phase drawing: ${paths.join(", ")}`]], ["a", []]]);
    expect(s.pure).toEqual({ ui: [`   the screens follow the phase drawing: ${paths.join(", ")}`], logic: [], noDrawing: [] });
  });

  it("[sma:p4_deps] a piece is issued once its own dependencies are accepted, not the whole earlier wave; a broken piece holds what depends on it and nobody else", async () => {
    const s = await seen("deps");
    expect(s.none).toEqual(["a", "c"]);
    // a is accepted, c still runs: b (wave 2, needs a) goes; d (needs b and c) does not.
    expect(s.oneAcceptedOneRunning).toEqual(["b"]);
    expect(s.oneBlocked).toEqual([]);
    expect(s.notIssuedYet).toEqual(["a", "c", "b"]);
    expect(s.bothDone).toEqual([]);
    expect(s.afterB).toEqual(["d"]);
    expect(s.queuedIsNotAccepted).toEqual(["c"]);
    // "e" needs a piece the plan does not hold and "f" needs itself: neither is ever issued.
    for (const rows of Object.values(s)) { expect(rows).not.toContain("e"); expect(rows).not.toContain("f"); }
  });

  it("[sma:p4_plan_runs] each piece is its own work: its own task id and contract, quality mode full, and a plan text with the steps of that contract", async () => {
    const s = await seen("pieceRuns");
    expect(s).toEqual([
      { id: "a", quality_mode: "full", priority: "high", verification: [{ command: "npm test -- a" }], acceptance: ["works"], owns_paths: ["src/a.ts"],
        steps: ["2. Run the checks, red before the work: npm test -- a", "3. Write the files this piece owns: src/a.ts", "4. Done when: works"] },
      { id: "b", quality_mode: "full", priority: null, verification: [{ command: "npm test -- b" }, { command: "npm run lint" }], acceptance: ["b works", "b is fast"], owns_paths: ["src/b.ts"],
        steps: ["2. Run the checks, red before the work: npm test -- b; npm run lint", "3. Write the files this piece owns: src/b.ts", "4. Done when: b works; b is fast"] },
    ]);
  });
});

describe("the execution of the phase (n66 … n75)", () => {
  it("[sma:p4_nested_batch] a phase executing its plan in a run closes with that run when a person closes it, naming the run; the hub's own cleaning of the run ends nobody's plan", async () => {
    const s = await seen("nestedBatch");
    const closed = { state: "closed", stage: "closed", closing: "batch closed: run1", book: ["batch closed: run1"], dispatched: 0 };
    expect(s.cli).toEqual(closed);
    expect(s.rpc).toEqual(closed);
    for (const hub of [s.sweep, s.ttl]) expect(hub).toEqual({ state: "active", stage: "execution", closing: null, book: [], dispatched: 1 });
  });

  it("[sma:p4_waits] the execution waits for every piece: one not issued or not accepted is named, and the gate opens when all are accepted", async () => {
    const s = await seen("executionWait");
    expect(s.nothingIssued).toEqual(["a is not issued yet", "b is not issued yet"]);
    expect(s.half).toEqual(["b is not issued yet"]);
    expect(s.running).toEqual(["b is running"]);
    expect(s.blocked).toEqual(["b is blocked"]);
    expect(s.noFact).toEqual(["b is queued"]);
    expect(s.allIn).toEqual([]);
  });

  it("[sma:p4_cmd] the execution command tells the PM what runs, what is blocked and what could not be issued, each with its own key", async () => {
    const s = await seen("executionText");
    expect(s.running).toEqual({ key: "execution:running:1:1", waitsForPm: false,
      text: "Phase ph_1 «Sums» — stage 4, execution: 1 of 2 pieces issued, 1 at work. Lane Pilot issues each further piece itself once the pieces it depends on are accepted." });
    expect(s.blocked.key).toBe("execution:blocked:a");
    expect(s.blocked.waitsForPm).toBe(true);
    expect(s.blocked.text).toBe("Phase ph_1 «Sums» — stage 4, execution: a is blocked. Decide each: lane_pilot_phase {action:\"decide\", phaseId:\"ph_1\", piece:\"a\", choice:\"skip\"|\"retry\"|\"cancel\", note} — skip drops it, retry issues it again, cancel stops the phase.");
    expect(s.issueError.key).toBe("execution:issue_error:b");
    expect(s.issueError.waitsForPm).toBe(true);
    expect(s.issueError.text).toContain("Lane Pilot could not issue b (dispatch refused)");
  });

  it("[sma:p4_begin] before the writer starts the checks of the task run on the base in a worktree of their own and the answer is booked: which are green, which red, on which commit", async () => {
    vi.setConfig({ testTimeout: 180_000 });
    const w = await world();
    const input = w.pendingTask("t1", ["test -f keep.txt", "test -f feature.txt"]);
    const result = await w.services.baseline.preflight(input);
    expect(result.stop).toBeNull();
    const row = getBaseline(w.db, "run1", "t1")!;
    expect(row).toMatchObject({ state: "ran", verdict: "partial", action: "proceed", baseSha: git(w.base, "rev-parse", "HEAD").trim() });
    expect(row.checks.map((check) => [check.command, check.status])).toEqual([["test -f keep.txt", "green"], ["test -f feature.txt", "red"]]);
    expect(w.runs.every((run) => run.cwd !== w.base)).toBe(true);
    expect(w.worktrees()).toBe(1);
    await w.dispose();
  }, 180_000);

  it("[sma:p4_calc] what a piece's work did is read from its latest attempt and the receipts of its stages, never from a claim", async () => {
    const s = await seen("calc");
    // a: the first attempt failed with red receipts, the redo a.2 is the latest: the facts are the redo's; a stage that is not one of the four is not read.
    expect(s.a).toEqual({ taskId: "a.2", state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", browserQa: "passed", qaPlanned: true, attempt: "att-a.2" });
    expect(s.b).toEqual({ taskId: "b", state: "running", planFact: null, verification: null, codeCritique: null, browserQa: null, qaPlanned: false, attempt: "att-b" });
    expect(s.c).toEqual({ taskId: "c", state: null, planFact: null, verification: null, codeCritique: null, browserQa: null, qaPlanned: false, attempt: null });
  });

  it("[sma:p4_steps] each piece's cycle is judged by its receipts: no receipt is no reading, a failed one is red, a claim that it is done grants nothing", async () => {
    const s = await seen("pieceCycle");
    const ok = (lines: Record<string, [boolean, string]>) => Object.entries(lines).filter(([, [good]]) => !good).map(([id]) => id);
    expect(ok(s.proved)).toEqual([]);
    expect(s.proved.independent_check).toEqual([true, "the code critic passed it"]);
    expect(s.noReceipts.promises_proved).toEqual([false, "plan-fact left no receipt"]);
    expect(s.noReceipts.independent_check).toEqual([false, "the code critic has not passed it (no critic receipt is no reading)"]);
    expect(ok(s.noReceipts)).toEqual(["promises_proved", "independent_check"]);
    expect(s.blocked.independent_check).toEqual([false, "the code critic blocks it"]);
    expect(ok(s.failed)).toEqual(["landed", "promises_proved", "checks_passed"]);
    expect(s.failed.checks_passed).toEqual([false, "its checks failed"]);
    // A docs piece owes no plan-fact; a piece never issued holds nothing.
    expect(ok(s.docsSkipped)).toEqual([]);
    expect(ok(s.neverIssued)).toEqual(["landed", "promises_proved", "independent_check"]);
    expect(s.neverIssued.landed).toEqual([false, "is not issued"]);
  });

  it("[sma:p4_complete] a wave is handed in as a package with the lines its pieces hold, written to the book once, and a blocked piece is reported, not handed in", async () => {
    const s = await seen("waveIn");
    expect(s.handedIn.book).toEqual(["wave 1 in, package <pkg>: ✓ contract_current, ✓ landed, ✓ promises_proved, ✓ checks_passed, ✗ independent_check, ✓ qa_read"]);
    expect(s.handedIn.bookAfterSecondPass).toBe(1);
    expect(s.handedIn.packageIsOfThePieces).toBe(true);
    expect(s.handedIn.lines).toEqual({
      contract_current: [true, "2 piece(s) hold contract_current"], landed: [true, "2 piece(s) hold landed"], promises_proved: [true, "2 piece(s) hold promises_proved"],
      checks_passed: [true, "2 piece(s) hold checks_passed"], independent_check: [false, "independent_check fails: b"], qa_read: [true, "2 piece(s) hold qa_read"],
    });
    expect(s.handedIn.pieceLines).toEqual({ a: [], b: ["independent_check"] });
    expect(s.blocked).toEqual({ waveIn: 0, wavesRecorded: [], stage: "execution", key: "execution:blocked:b", waitsForPm: true, decides: true });
  });

  it("[sma:p4_qa] a browser check that was planned and has not passed is not a pass, a failed one is red, and one taken on another candidate does not transfer", async () => {
    const s = await seen("liveQa");
    expect(s.notRun).toEqual({ ok: false, detail: "the planned browser check has not passed: a" });
    expect(s.failed).toEqual({ ok: false, detail: "the browser check failed: a" });
    expect(s.passed).toEqual({ ok: true, detail: "1 piece(s) passed their browser check" });
    expect(s.nonePlanned).toEqual({ ok: true, detail: "0 piece(s) passed their browser check; 1 piece(s) plan none (no qa_cases)" });
    expect(s.foreignGreen).toEqual({ ok: false, detail: `the live check was taken on head ${"1".repeat(12)}, the package it decides on is at ${"2".repeat(12)} — check the same candidate` });
    expect(s.sameCandidate).toEqual({ ok: true, detail: "1 piece(s) passed their browser check" });
  });

  it("[sma:p4_to_verify] the phase leaves the execution only when every piece is issued and accepted: not while one runs, not while one is not issued", async () => {
    const s = await seen("toVerification");
    expect(s.whileRunning).toBe("execution");
    expect(s.notIssued).toBe("execution");
    expect(s.afterAccepted).toBe("verification");
    expect(s.book).toEqual(["execution → verification: every piece is issued and accepted"]);
  });
});

describe("the phase's own verification (n76 … n89)", () => {
  it("[sma:p5_barrier] the barrier of the phase is one regression run over the whole candidate: every tree of it, forced, in full; its goal is kept on the phase", async () => {
    const s = await seen("barrier");
    expect(s.regression).toEqual([{ projectId: "projA", runId: "run1", force: true, mode: "full", basePaths: ["/repo/.git/lp-phases/ph_1"] }]);
    expect(s.goalCheckOfMain).toBe(0);
    expect(s.goal).toEqual({ state: "passed", tasks: 2, headSha: H, runId: "run1" });
  });

  it("[sma:p5_inputs] the goal audit is handed every piece's promise, the diff range of the phase and the drawing", async () => {
    const s = await seen("closeInputs");
    expect(s.goal).toBe("sums are right");
    expect(s.goals.map((g) => [g.id, g.done_when])).toEqual([
      ["p1", "given an empty cell; when the sum runs; then it skips the cell (p1); accepts: acc-p1"],
      ["p2", "given an empty cell; when the sum runs; then it skips the cell (p2); accepts: acc-p2"],
    ]);
    expect(s.merged).toEqual(["base0..phase/ph_1"]);
    expect(s.landed.merged).toEqual(["base0..HEAD"]);
    expect(s.plain.merged).toEqual([]);
    expect(s.drawing).toEqual({ paths: ["d/UI-SPEC.md", "d/one.html"], sha256: "drawsha", ui_spec: "d/UI-SPEC.md" });
    expect(s.plain.drawing).toBeNull();
    expect(s.points).toEqual([{ id: "design_1", text: "a primary button" }]);
  });

  it("[sma:p5_blind] the blind verdict is decided by code from the plan and the receipts alone: each reason is named, a clean plan passes", async () => {
    const s = await seen("verdicts");
    expect(s.allProved).toEqual({ state: "passed", detail: "every piece accepted and proved; the composition passes on main", mainSha: "h1" });
    expect(s.firstChecksFailed).toEqual({ state: "failed", detail: "a: its checks failed", mainSha: "h1" });
    expect(s.lastPlanFactFailed).toEqual({ state: "failed", detail: "c: plan-fact failed — the promise is not proved", mainSha: "h1" });
    expect(s.planFactSkipped.detail).toBe("b: plan-fact was skipped — its acceptance items were not checked against the diff");
    expect(s.noChecksReceipt.detail).toBe("b: its checks left no receipt — nothing is known to have run");
    expect(s.checksSkipped.detail).toBe("b: its checks were skipped — nothing ran");
    expect(s.criticBlocks.detail).toBe("c: the code critic blocks it");
  });

  it("[sma:p5_blind_wall] a piece the worker says is done but left no receipt is not proved: the verdict reads receipts, never a story", async () => {
    const s = await seen("verdicts");
    expect(s.noPlanFactReceipt).toEqual({ state: "failed", detail: `b: ${NO_RECEIPT}`, mainSha: "h1" });
    expect(s.allProved.state).toBe("passed");
    expect(s.allProved.detail).not.toContain("no receipt");
  });

  it("[sma:p5_blind_frozen] the verdict is frozen on its facts: the same facts give the same verdict, new facts a new one, and the clock does not", async () => {
    const v = (await seen("verdicts")).stable;
    expect(v.sameFactsSameInput).toBe(true);
    expect(v.newFactNewInput).toBe(true);
    expect(v.newGoalNewInput).toBe(true);
    expect(v.fewerPiecesNewInput).toBe(true);
    const f = await seen("frozen");
    expect(f.pending).toEqual({ verdict: null, book: 0, checks: 1 });
    expect(f.frozen.checks).toBe(2);
    expect(f.later).toEqual({ sameVerdict: true, state: "passed", book: 1, checks: 2 });
  });

  it("[sma:p5_summaries] the verdict composes every piece of the plan: a piece anywhere in it that is not proved fails the whole", async () => {
    const s = await seen("verdicts");
    expect(s.firstChecksFailed.state).toBe("failed");
    expect(s.firstChecksFailed.detail).toBe("a: its checks failed");
    expect(s.lastPlanFactFailed.detail).toBe("c: plan-fact failed — the promise is not proved");
    expect(s.allProved.state).toBe("passed");
  });

  it("[sma:p5_design] the verdict is bound to the confirmed drawing: its hash is recomputed from the files and a drawing changed after the confirmation fails the verdict", async () => {
    const s = await seen("verdicts");
    expect(s.drawingUnchanged).toEqual({ state: "passed", detail: "every piece accepted and proved; the composition passes on main", mainSha: "h1" });
    expect(s.drawingChanged).toEqual({ state: "failed", detail: "the drawing changed since it was confirmed: confirmed aaa, now bbb", mainSha: "h1" });
    expect(s.stable.drawingBound).toBe(true);
    expect(s.stable.drawingHashNewInput).toBe(true);
    expect(s.stable.drawingPathNewInput).toBe(true);
    const d = await seen("drawingBound");
    expect(d.same).toEqual({ state: "passed", detail: "every piece accepted and proved; the composition passes on main" });
    expect(d.changed).toEqual({ state: "failed", detail: "the drawing changed since it was confirmed: confirmed <confirmed>, now <now>" });
    expect(d.differentInput).toBe(true);
  });

  it("[sma:p5_prompt] the goal audit is handed each piece's contract and dependencies and the words of the blind verdict", async () => {
    const s = await seen("closeInputs");
    expect(s.goals.find((g) => g.id === "p2")).toEqual({ id: "p2", done_when: "given an empty cell; when the sum runs; then it skips the cell (p2); accepts: acc-p2", depends_on: ["p1"],
      contract: { acceptance: ["acc-p2"], verification: [{ command: "npm test -- p2" }], owns_paths: ["src/p2.ts"] } });
    expect(s.goals.find((g) => g.id === "p1")!.depends_on).toEqual([]);
    expect(s.summary).toBe("The phase's work is on branch phase/ph_1, checked out at /repo/wt, and lands on main only after the acceptance: read and run the evidence there. the blind detail");
    expect(s.landed.summary).toBe("the blind detail");
    expect(s.plain.summary).toBe("the blind detail");
  });

  it("[sma:p5_verdict] the phase verdict is recorded with its facts: passed with the head it saw, failed with every reason, pending while the goal check runs and nothing is frozen", async () => {
    const s = await seen("verdicts");
    expect(s.allProved).toEqual({ state: "passed", detail: "every piece accepted and proved; the composition passes on main", mainSha: "h1" });
    expect(s.goalRunning).toEqual({ state: "pending", detail: "the run's goal check is still running", mainSha: null });
    expect(s.goalFailed).toEqual({ state: "failed", detail: "the run's goal check failed: npm test is red", mainSha: null });
    expect(s.goalPartial).toEqual({ state: "failed", detail: "the run's goal check is partial, not a full pass", mainSha: null });
    expect(s.goalNever).toEqual({ state: "failed", detail: "the run's goal check has not run yet", mainSha: null });
    const f = await seen("frozen");
    expect(f.pending.verdict).toBeNull();
    expect(f.frozen).toEqual({ state: "passed", detail: "every piece accepted and proved; the composition passes on main", mainSha: H, book: ["passed: every piece accepted and proved; the composition passes on main (input <input>)"], checks: 2 });
  });

  it("[sma:p5_prepare] the candidate's own tree is verified and its head frozen as the package: the verdict and the verified heads speak of one tree", async () => {
    const s = await seen("barrier");
    expect(s.verified).toEqual({ "/repo": H });
    expect(s.verdict).toEqual({ state: "passed", detail: "every piece accepted and proved; the composition passes on main", mainSha: H });
    expect(s.goal!.headSha).toBe(H);
  });

  it("[sma:p5_all_plans] nothing is prepared without every plan: a piece that is not accepted, or not issued, fails the verdict and names itself", async () => {
    const s = await seen("verdicts");
    expect(s.oneRunning).toEqual({ state: "failed", detail: "b not accepted", mainSha: "h1" });
    expect(s.oneNotIssued).toEqual({ state: "failed", detail: `b not accepted; b: ${NO_RECEIPT}; b: its checks left no receipt — nothing is known to have run`, mainSha: "h1" });
    expect(s.allProved.state).toBe("passed");
  });

  it("[sma:p5_main_same] acceptance holds when main is no longer the commit the verdict saw, and the phase is verified again on the main that is there", async () => {
    const s = await seen("mainMoved");
    expect(s.lines.same).toEqual({ ok: true, detail: "main is where the verdict saw it" });
    expect(s.lines.moved).toEqual({ ok: false, detail: `main moved from ${M.slice(0, 12)} to ${H.slice(0, 12)} since the verdict — verify again` });
    expect(s.lines.unknownNow.ok).toBe(true);
    expect(s.lines.unknownThen.ok).toBe(true);
    expect(s.driver).toEqual({ stage: "verification", verdict: null, acceptance: null, candidate: { verified: null, goal: null }, book: "acceptance → verification: main moved since the verdict: verified again" });
  });

  it("[sma:p5_uat_stage] the work verification opens only on the candidate's frozen heads: its lines are numbered from 1, one per piece", async () => {
    const s = await seen("uatStage");
    expect(s.unverified).toEqual({ uat: null, written: 0 });
    expect(s.verified.uat).toEqual({ path: ".agents/phases/<id>/UAT.md", sha256: "", lines: [{ n: 1, pieceId: "p1", state: "open" }, { n: 2, pieceId: "p2", state: "open" }, { n: 3, pieceId: "p3", state: "open" }] });
    expect(s.verified.written).toBe(0);
    expect(s.noCandidate.uat!.lines).toEqual(s.verified.uat!.lines);
  });

  it("[sma:p5_uat_cmd] the verification document has one numbered line per promise, says where to test, and shows the person's answers as they stand", async () => {
    const s = await seen("uatDocument");
    expect(s.plain).toEqual([
      "# UAT — phase ph_7: Sums", "", "Goal: sums are right", "", "Test the work on main.", "",
      "One line per test, answered by its number with uat_line (pass or fail). The phase is accepted only when every line passed.", "",
      "- [ ] 1. p1: given an empty cell, when the sum runs, then it skips the cell (p1)", "- [ ] 2. p2: given an empty cell, when the sum runs, then it skips the cell (p2)", "",
    ]);
    expect(s.answered).toEqual(["- [x] 1. p1: given an empty cell, when the sum runs, then it skips the cell (p1)", "- [!] 2. p2: given an empty cell, when the sum runs, then it skips the cell (p2) — the bar is gone"]);
    expect(s.onCandidate).toBe("Test the work on the phase candidate branch phase/ph_7 — worktree(s): /repo/wt. Do not test main: it does not have this phase's work yet.");
    expect(s.onVerified).toBe(`Test the work on the phase candidate branch phase/ph_7 at the verified head ${H.slice(0, 12)} — worktree(s): /repo/wt. Do not test main: it does not have this phase's work yet.`);
    expect(s.landed).toBe("Test the work on main: the phase landed (phase/ph_7).");
    expect(s.none).toEqual([]);
  });
});
