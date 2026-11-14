// Region 16 (slash commands and workflows), batch b: the execute-phase tail, the todo/note/seed commands, verify-work, lessons and graduation (n1174 … n1204).
// Every test runs the real code of the node through tests/sma/r16-world-b.ts (the same observations the scene scripts/lp_drill/scenes/sma_r16_b.py proves) and checks the
// result the card names: what was issued, written, told to the PM, refused.
import { describe, expect, it } from "vitest";
import { observeB } from "./r16-world-b";

const PROMISES = (n: number) => `given g, when w, then then-p${n}`;

describe("the execution tail (n1174 … n1183)", () => {
  it("[sma:k_we_waves] the pieces of a wave go out in parallel in one pass, up to the issue cap, and the next pass goes on from where the phase stands", async () => {
    const seen = await observeB.k_we_waves();
    expect(seen.open).toEqual({ first: ["a", "b", "c"], second: ["a", "b", "c"], issued: ["a", "b", "c"] });
    expect(seen.capped).toEqual({ first: ["a", "b"], second: ["a", "b", "c"], issued: ["a", "b", "c"] });
  });

  it("[sma:k_we_inline] a run without subagents issues one piece per pass, in plan order; with subagents the whole wave goes at once", async () => {
    const seen = await observeB.k_we_inline();
    expect(seen.inline).toEqual({ first: ["a"], second: ["a", "b"] });
    expect(seen.withSubagents).toEqual({ first: ["a", "b", "c"], second: ["a", "b", "c"] });
  });

  it("[sma:k_we_aggregate] the wave's result counts its pieces per acceptance line and names the pieces that break one", () => {
    const seen = observeB.k_we_aggregate();
    expect(seen.held).toEqual([
      ["contract_current", true, "2 piece(s) hold contract_current"], ["landed", true, "2 piece(s) hold landed"], ["promises_proved", true, "2 piece(s) hold promises_proved"],
      ["checks_passed", true, "2 piece(s) hold checks_passed"], ["independent_check", true, "2 piece(s) hold independent_check"], ["qa_read", true, "2 piece(s) hold qa_read"],
    ]);
    expect(seen.broken.filter((line) => line[1] === false)).toEqual([["independent_check", false, "independent_check fails: p2"]]);
    expect(seen.broken.filter((line) => line[1] === true)).toHaveLength(5);
    expect(seen.perPiece).toEqual(["p1", "p2"]);
    expect(seen.brokenPiece).toEqual(["independent_check"]);
  });

  it("[sma:k_we_codereview] the code critic's advice does not hold the task in advisory mode: only a block or a blocking finding on a rubric criterion stops it; gate mode stops on any request", () => {
    const seen = observeB.k_we_codereview();
    // [gate, advisory]
    expect(seen.approved).toEqual([false, false]);
    expect(seen.adviceOnly).toEqual([true, false]);
    expect(seen.blockingRubric).toEqual([true, true]);
    expect(seen.blockingOther).toEqual([true, false]);
    expect(seen.blockStatus).toEqual([true, true]);
    expect(seen.feedback).toBe("code critic (advisory): style: the style note");
    expect(seen.noAdvice).toBe("");
    expect(seen.advisoryMode).toBe("advisory");
    expect(seen.defaultMode).toBe("gate");
  });

  it("[sma:k_we_regression] before the goal check the regression pass of the earlier work runs in full on the candidate's tree, and a red check fails the verdict", async () => {
    const seen = await observeB.k_we_regression();
    expect(seen.call).toEqual({ projectId: "projA", runId: "run1", force: true, mode: "full", basePaths: [seen.greenTree] });
    expect(seen.green).toEqual({ stage: "verification", verdict: "passed" });
    expect(seen.red).toEqual({ verdict: "failed", detail: "the run's goal check failed" });
  });

  it("[sma:k_we_verify] visible work owes a passed live check where the check is on, taken on the same candidate the acceptance decides on", () => {
    const seen = observeB.k_we_verify();
    expect(seen.skipped).toBe(false);
    expect(seen.passed).toBe(true);
    expect(seen.notOwed).toBe(true);
    expect(seen.onOtherHead).toEqual([false, "the live check was taken on head v0, the package it decides on is at v1 — check the same candidate"]);
    expect(seen.onSameHead).toEqual([true, "1 piece(s) passed their browser check"]);
  });

  it("[sma:k_we_uiqa] the live interface check is due after the blind verdict, only where the check is on and a piece built screens, and once", () => {
    const seen = observeB.k_we_uiqa();
    expect(seen).toEqual({ withUi: "live", checkOff: "close", taken: "close", noScreens: "close", beforeVerdict: null });
  });

  it("[sma:k_we_roadmap] the closed phase's roadmap row gets its [x]; the other rows and the parked backlog stay as they were", async () => {
    const seen = await observeB.k_we_roadmap();
    expect(seen.rows).toEqual(["- [x] 1.1 Hud — build it", "- [ ] 1.2 Menu — the menu", "- [ ] 999.1 Later — parked"]);
    expect(seen.parked).toBe(true);
    expect(seen.pure).toEqual(["- [ ] 1.1 Hud — build it", "- [x] 1.2 Menu — the menu", "- [ ] 999.1 Later — parked"]);
    expect(seen.unknown).toBe(true);
  });

  it("[sma:k_we_learnings] the lesson waits as a draft for the owner; his yes puts it into the project's memory, his no leaves memory empty", async () => {
    const seen = await observeB.k_we_learnings();
    const lesson = "Phase «Sums» lessons: The plan missed the empty-cell case; a check per promise would have caught it.";
    expect(seen.yes).toEqual({ staged: ["staged", 0], after: ["applied", [["phase-lessons", lesson]]] });
    expect(seen.no).toEqual({ staged: ["staged", 0], after: ["declined", []] });
  });

  it("[sma:k_we_next] the next roadmap row (never a parked 999 one) is told to the PM, or opened at once in autonomous mode; a verdict with gaps is replanned instead", async () => {
    const seen = await observeB.k_we_next();
    expect(seen.told).toBe("Next on the roadmap: 1.2 «Menu» — the menu");
    expect(seen.autoOpened).toEqual(["autonomous: the next phase <id> «Menu» (roadmap 1.2) is open"]);
    expect(seen.autoPhases).toEqual([["Menu", "1.2"]]);
    expect(seen.rows).toEqual([{ n: "1.1", name: "Hud", goal: "build it" }, "1.2", null, "999.1"]);
    expect(seen.gaps).toBe("replan");
  });
});

describe("the todo, note and idea commands (n1184 … n1190)", () => {
  it("[sma:k_c_addtodo] a thought becomes a todo folder with a readable meta.yaml and the thought's body, and the backlog board offers it as it is", async () => {
    const seen = await observeB.k_c_addtodo();
    expect(seen.status).toBe("succeeded");
    expect(seen.folders).toEqual(["<day>-<run>"]);
    expect(seen.meta).toMatchObject({ title: "Fix flaky test", status: "ready", priority: "high", estimate: 3, dependsOn: [] });
    expect(seen.readme).toBe("the flaky payments test");
    expect(seen.output).toEqual({ status: "done", line: "todo added", idIsFolder: true });
    expect(seen.board).toEqual([true]);
  });

  it("[sma:k_c_note] a note is one write and one confirmation line, no questions asked", async () => {
    const seen = await observeB.k_c_note();
    expect(seen.status).toBe("succeeded");
    expect(seen.output).toEqual({ status: "done", confirmation: "note saved" });
    expect(seen.notes).toBe(1);
    expect(seen.file).toBe("note.md");
    expect(seen.body).toBe("---\ncreated: <day>\nsource: note-add\n---\n\ndeploy is manual\n");
    expect(seen.path).toBe(true);
  });

  it("[sma:k_c_seed] an idea for later is a todo with the conditions to come back: it stays off the board until what it depends on is done", () => {
    const seen = observeB.k_c_seed();
    expect(seen.parsed).toEqual({ id: "x1", title: "Try the cache", status: "ready", priority: "low", estimate: 5, dependsOn: ["a", "b"], created: "2026-11-02" });
    expect(seen.noId).toBeNull();
    expect(seen.board).toEqual({ issuable: ["later"], blocked: ["waits"] });
  });

  it("[sma:k_c_backlog] a parked item gets the next 999 number under the exact `## Backlog` heading as one line, and the machine never opens it as the next phase", () => {
    const seen = observeB.k_c_backlog();
    expect(seen.first).toEqual(["999.1", ["- [ ] 1.1 Hud — build it", "## Backlog", "- [ ] 999.1 Later idea — do it after the hud"]]);
    expect(seen.second).toEqual(["999.2", ["- [ ] 1.1 Hud — build it", "- [ ] 999.1 Later idea — do it after the hud", "- [ ] 999.2 Another — x"]]);
    expect(seen.hostile).toEqual(["- [ ] 999.2 Evil - [ ] 1.9 injected — line one ## Backlog2"]);
    expect(seen.next).toBe("1.1");
  });

  it("[sma:k_c_checktodos] the todo list is ordered for a pick (urgency, then the smaller job), what cannot be picked is listed with why, and the pick comes with the order to act on it", () => {
    const seen = observeB.k_c_checktodos();
    expect(seen.order).toEqual(["high-small", "high-big", "mid", "low-small"]);
    expect(seen.needsEstimate).toEqual(["none"]);
    expect(seen.decompose).toEqual(["huge"]);
    expect(seen.order1).toBe("Lane Pilot: из беклога проекта готова к работе задача «todo high-small» (high-small, оценка 2, приоритет high).\nОписание и подход: .agents/todos/items/high-small/AGENT.md и README.md. Составь контракт и отправь писателю; в meta.yaml добавь run в related_runs.");
  });

  it("[sma:k_c_listseeds] the idea list is read-only and open ideas only: a done one is not listed or matched, every status is read as it is", () => {
    const seen = observeB.k_c_listseeds();
    expect(seen.board).toEqual([["r"], [], []]);
    expect(seen.like).toEqual(["x"]);
    expect(seen.parsed).toEqual([["a", "ready"], ["b", "idea"]]);
    expect(seen.readOnly).toBe(true);
  });

  it("[sma:k_c_thread] a note one session wrote is found by another from any machine, only inside its project, and a secret is refused at the door", async () => {
    const seen = await observeB.k_c_thread();
    expect(seen.where).toEqual([{ projectId: "P", scopes: ["section:bot"] }, { projectId: "P", scopes: [] }, { projectId: null, scopes: [] }]);
    expect(seen.written).toBe(true);
    expect(seen.found).toEqual(["The reports page lives in components/reports and reads the daily table."]);
    expect(seen.other).toBe(0);
    expect(seen.secret).toEqual([false, true]);
  });
});

describe("verify-work and the verification stage (n1192 … n1194, n1201 … n1204)", () => {
  it("[sma:k_c_verify] the acceptance document has one numbered line per promise, an answer changes only its line, and the file reads back what is passed, failed and open", () => {
    const seen = observeB.k_c_verify();
    expect(seen.head).toEqual(["# UAT — phase ph_sma: Sum", "", "Goal: sums", "", "Test the work on main."]);
    expect(seen.lines).toEqual([`- [ ] 1. p1: ${PROMISES(1)}`, `- [ ] 2. p2: ${PROMISES(2)}`, `- [ ] 3. p3: ${PROMISES(3)}`]);
    expect(seen.changed).toEqual([`- [x] 2. p2: ${PROMISES(2)} — works`, `- [!] 3. p3: ${PROMISES(3)} — the total is wrong`]);
    expect(seen.state).toEqual({ lines: 3, passed: 1, failed: [`3. p3: ${PROMISES(3)} — the total is wrong`], open: [`1. p1: ${PROMISES(1)}`] });
    expect(seen.none).toBeNull();
    expect(seen.fresh).toMatchObject({ lines: 3, passed: 0, failed: [] });
    expect(seen.candidate).toBe("Test the work on the phase candidate branch phase/x at the verified head abcdef123456 — worktree(s): /r/t. Do not test main: it does not have this phase's work yet.");
  });

  it("[sma:k_c_verifyphase] the goal-backward verdict is decided by code from the receipts and the run's goal check: it names what is not proved, waits for a running check and is frozen by its input", () => {
    const seen = observeB.k_c_verifyphase();
    expect(seen.passed).toEqual(["passed", "every piece accepted and proved; the composition passes on main"]);
    expect(seen.unproved).toEqual(["failed", "p2: plan-fact failed — the promise is not proved"]);
    expect(seen.noGoal).toEqual(["failed", "the run's goal check has not run yet"]);
    expect(seen.goalFailed).toEqual(["failed", "the run's goal check failed: npm test red"]);
    expect(seen.running).toEqual(["pending", "the run's goal check is still running"]);
    expect(seen.same).toBe(true);
    expect(seen.document).toEqual(["# Verification — phase ph_sma: Sum", "", "Goal: sums", ""]);
  });

  it("[sma:k_c_diagnose] where phase.diagnose is on, a failed verdict goes to the debuggers (one per gap, six at most) and their diagnoses come back together; off, it is replanned at once", async () => {
    const seen = await observeB.k_c_diagnose();
    expect(seen.due).toBe("diagnose");
    expect(seen.off).toBe("replan");
    expect(seen.two).toEqual(["ask_symptoms diagnose diagnosed", 2]);
    expect(seen.seven).toEqual(["ask_symptoms diagnose diagnosed", 6]);
  });

  it("[sma:k_wv_rubric] the verification rubric names its order and its blocking antipatterns; a writer's own report is not read, only receipts", () => {
    const seen = observeB.k_wv_rubric();
    expect(seen.rubric).toBe("Order of work: 1) initialize: the promises, the drawing contract points, the acceptance checks; 2) run every piece's checks together on main (the blind verdict); 3) the live interface check where screens changed; 4) audit the goal against the phase goal and the drawing; 5) diagnose gaps, plan the gap closure, check it, revise. Blocking: verifying on a main that moved since; a goal audit by the author of the work; a passed check that proves only that a file exists.");
    expect(seen.selfReport).toEqual(["failed", "p1: plan-fact left no receipt — its acceptance items were not checked against the diff; p1: its checks left no receipt — nothing is known to have run"]);
    expect(seen.proved).toBe("passed");
  });

  it("[sma:k_wv_init] the verification starts from one list: the spec, the validation and only the drawing's contract", () => {
    const seen = observeB.k_wv_init();
    expect(seen.verification).toEqual([".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/VALIDATION.md", ".agents/phases/ph_sma/design/UI-SPEC.md"]);
    expect(seen.plain).toEqual([".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/VALIDATION.md"]);
  });

  it("[sma:k_wv_active] an open acceptance session is read from its file: the lines by state, the next one is the first unanswered, a file with no lines is no session", () => {
    const seen = observeB.k_wv_active();
    expect(seen.state).toEqual({ lines: 4, passed: 1, failed: ["2. p2: given g, when w, then t2 — wrong"], open: ["3. p3: given g, when w, then t3", "4. p4: given g, when w, then t4"] });
    expect(seen.next).toBe("3. p3: given g, when w, then t3");
    expect(seen.none).toEqual({ lines: 0, passed: 0, failed: [], open: [] });
    expect(seen.crlf).toEqual({ lines: 2, passed: 1, failed: [], open: ["2. b"] });
  });

  it("[sma:k_wv_autoui] the interface check starts by itself for a phase that built screens and is given the visible pieces' address and flows; a backend phase has none", () => {
    const seen = observeB.k_wv_autoui();
    expect(seen.builds).toEqual([true, false, true, true]);
    expect(seen.due).toBe("live");
    expect(seen.inputs).toEqual({ url: "http://127.0.0.1:5173/", urls: ["http://127.0.0.1:5173/"], flows: ["v1: given g; when w; then then-v1"], dev_server: "npm run dev" });
    expect(seen.backendOnly).toBe("close");
    expect(seen.noAnswer).toBe("verification:live");
  });
});

describe("the transition (n1195)", () => {
  it("[sma:k_c_transition] a closed phase finishes its paperwork once: SUMMARY.md, the roadmap row, STATE's phase and stage with the person's text kept, one commit, then it is closed for good", async () => {
    const seen = await observeB.k_c_transition();
    expect(seen.state).toBe("closed");
    expect(seen.closed).toBe(true);
    expect(seen.summary).toBe("# Summary — phase <id>: Hud");
    expect(seen.stateHas).toEqual([true, true, true, true]);
    expect(seen.committed).toEqual([[".agents/phases/<id>/SUMMARY.md", ".agents/planning/ROADMAP.md", ".agents/planning/STATE.md"]]);
    expect(seen.message).toBe("phase <id>: closed — summary, roadmap and state");
    expect(seen.booked).toBe(1);
  });
});

describe("the lessons stage and graduation (n1196 … n1200)", () => {
  it("[sma:k_c_graduation] a lesson graduates into a rule's mechanism by recurrence, not by a command: three records, the owner's decision or a confirmed trial; a held or prose rule never", () => {
    const seen = observeB.k_c_graduation();
    expect(seen).toEqual({ twice: null, thrice: "recurred", owner: "owner", confirmed: "confirmed", proposed: null, held: null, notAMechanism: null });
  });

  it("[sma:k_c_lessons] the lessons stage takes a reviewed analysis only at the lessons stage, keeps its author, reviewer and the hash the reviewer read, and closes the phase", async () => {
    const seen = await observeB.k_c_lessons();
    expect(seen.early).toBe("phase <id> is at discussion, not lessons");
    expect(seen.stage).toBe("closed");
    expect(seen.lessons).toMatchObject({ needed: true, why: "a return", analysis: "The plan missed the empty-cell case; a check per promise would have caught it.", author: "thr_retro", reviewer: "thr_stage", reviewRun: "wf_read", hashIsMeasured: true });
    expect(seen.book).toEqual(["The plan missed the empty-cell case; a check per promise would have caught it. (by thr_retro, read by thr_stage in wf_read, input <sha>)"]);
  });

  it("[sma:k_wl_rubric] a lesson is owed for a checkable reason (returns, failed attempts, failed verdicts); a clean phase is told so instead of an invented lesson", () => {
    const seen = observeB.k_wl_rubric();
    expect(seen.clean).toEqual({ needed: false, why: "the phase went through without returns or failures" });
    expect(seen.troubled).toEqual({ needed: true, why: "2 return(s) to an earlier stage, 1 failed attempt(s)" });
    expect(seen.verdict).toEqual({ needed: true, why: "3 failed verdict(s)" });
    expect(seen.rubric).toBe("Order of work: 1) read the whole book; 2) what went well, what went badly, the rules to keep; 3) a reviewer other than the author; 4) the lessons into memory; 5) the daemon writes the conclusion (SUMMARY.md) and marks the roadmap. Blocking: a lesson without evidence from the book; a review of another version of the book.");
  });

  it("[sma:k_wl_order] the author's analysis counts only when an independent reviewer session was handed exactly these bytes; each refusal says why", async () => {
    const seen = await observeB.k_wl_order();
    expect(seen.refusals).toEqual({
      missing: "run is not in the journal: the lessons name the run whose reviewer read them",
      self: "the reviewer of wf_self is not a session other than the analysis's author",
      other: "the reviewer step «stage» of wf_other did not receive these bytes: the analysis is not in its input",
      forged: "the journal's measurement of the reviewer's input does not match its bytes in wf_forged",
    });
    expect(seen.author).toBe("thr_retro");
    expect(seen.reviewer).toBe("thr_stage");
    expect(seen.bytesKept).toBe(true);
    expect(seen.analysis).toBe(true);
  });

  it("[sma:k_wl_write] the daemon writes the conclusion: into the project's memory at once, or as a draft that waits for the owner's word with nothing in memory yet", async () => {
    const seen = await observeB.k_wl_write();
    const lesson = "Phase «Sums» lessons: The plan missed the empty-cell case; a check per promise would have caught it.";
    expect(seen.direct).toEqual({ stage: "closed", draft: null, memory: [["phase-lessons", lesson]] });
    expect(seen.drafted).toEqual({ draft: "staged", memory: 0, text: lesson });
  });
});
