// Region 16 (slash commands and workflows), batch d: quick work, navigation and session commands, phase planning (n1237 … n1267).
// Every test runs the real code of the node through tests/sma/r16-world-d.ts (the same observations the scene scripts/lp_drill/scenes/sma_r16_d.py proves) and checks the
// result the card names: the path a quick task takes, what a gate refuses, what the PM is told, what a pause writes.
import { describe, expect, it } from "vitest";
import { observeD } from "./r16-world-d";

const QUICK = "class plan lint write state closed";
const REVIEWED = "class plan validate lint write review state closed_reviewed";

describe("quick work (n1237 … n1247)", () => {
  it("[sma:k_c_next] next tells the PM what the phase needs now and whether the machine waits for it: an open stage waits for the PM, a paused phase does not", async () => {
    const seen = await observeD.k_c_next();
    expect(seen.first).toEqual({ stage: "discussion", waitsForYou: true, next: `Phase ${seen.id} «Hud» — stage 1, discussion. Goal: hud`, hasHead: "string" });
    expect(seen.paused).toEqual({ stage: "discussion", waitsForYou: false, next: `Phase ${seen.id} «Hud» is paused; lane_pilot_phase {action:"resume", phaseId:"${seen.id}"} moves it on.` });
  });

  it("[sma:k_wq_init] the quick task's flags are all off by default and each one adds its own step", async () => {
    const seen = await observeD.k_wq_init();
    expect(seen.flags).toEqual({ full: false, validate: false, discuss: false, research: false });
    expect(seen.none).toBe(QUICK);
    expect(seen.validate).toBe(REVIEWED);
    expect(seen.full).toBe("class plan validate lint write-full review state closed_reviewed");
    expect(seen.research).toBe("class research plan lint write state closed");
    expect(seen.discuss).toBe("class discuss plan lint write state closed");
  });

  it("[sma:k_wq_dir] one quick task is one folder named by its id under .agents/tasks; an id that cannot be a folder name has no home", () => {
    const seen = observeD.k_wq_dir();
    expect(seen.home).toBe(".agents/tasks/quick-1");
    expect(seen.dotted).toBe(".agents/tasks/a.b_c-1");
    expect([seen.empty, seen.slash, seen.up, seen.space, seen.long]).toEqual([null, null, null, null, null]);
    expect(seen.abs).toBe("/repo/.agents/tasks/quick-1");
    expect(seen.absBad).toBeNull();
    expect(seen.owner).toBe("quick-1");
    expect(seen.ownerOther).toBeNull();
  });

  it("[sma:k_wq_discuss] the discussion step runs only with the flag: the owner is asked first and the plan comes after his answer", async () => {
    const seen = await observeD.k_wq_discuss();
    expect(seen.on).toBe("class discuss plan lint write state closed");
    expect(seen.asked).toBe(1);
    expect(seen.planAfter).toBe(true);
    expect(seen.off).toBe(QUICK);
    expect(seen.offAsked).toBe(0);
    expect([seen.humanType, seen.humanRole]).toEqual(["human", "owner"]);
  });

  it("[sma:k_wq_research] the research flag inserts the research step and the plan sees its notes; without it the plan sees none", async () => {
    const seen = await observeD.k_wq_research();
    expect(seen.on).toBe("class research plan lint write state closed");
    expect(seen.planSaw).toEqual({ research_notes: "files a.ts" });
    expect(seen.off).toBe(QUICK);
    expect(seen.offPlanSaw).toEqual({});
    expect(seen.role).toBe("analyst");
  });

  it("[sma:k_wq_plan] one plan for the task: a clear one-task plan goes on to the write, an unclear one stops, more than one task or a high risk is proposed to the full path, an already met goal closes untouched", async () => {
    const seen = await observeD.k_wq_plan();
    expect(seen.one).toEqual({ path: QUICK, status: "closed", comment: "quick path: built and verified" });
    expect(seen.notClear).toEqual({ path: "class plan blocked", status: "blocked", comment: "the issue is not clear enough to act on" });
    expect(seen.two).toEqual({ path: "class plan escalate proposed", status: "proposed", comment: "proposed to the full path" });
    expect(seen.high).toEqual({ path: "class plan escalate proposed", status: "proposed", comment: "proposed to the full path" });
    expect(seen.met).toEqual({ path: "class plan already", status: "closed", comment: "already met: nothing changed" });
    expect(seen.failed).toEqual({ path: "class plan partial", status: "partial", comment: "quick path: not finished" });
  });

  it("[sma:k_wq_check] the plan check runs only with --validate or --full, sends a rework back to the planner once and goes on after the second round", async () => {
    const seen = await observeD.k_wq_check();
    expect(seen.none).toBe(QUICK);
    expect(seen.ok).toBe(REVIEWED);
    expect(seen.once).toBe("class plan validate plan validate lint write review state closed_reviewed");
    expect(seen.twice).toBe("class plan validate plan validate lint write review state closed_reviewed");
    expect([seen.validations, seen.plans]).toEqual([2, 2]);
    expect(seen.full).toBe("class plan validate lint write-full review state closed_reviewed");
    expect(seen.role).toBe("plan-critic");
  });

  it("[sma:k_wq_exec] the executor writes by the task's risk and flag (quick, standard, full quality mode), hands its commits on and a failed write leaves the task partial", async () => {
    const seen = await observeD.k_wq_exec();
    expect(seen.modes).toEqual({ write: "quick", "write-medium": "standard", "write-full": "full" });
    expect(seen.low).toBe(QUICK);
    expect(seen.lowOut).toEqual({ status: "closed", severity: "low", resolution: "fixed", comment: "quick path: built and verified", merged_commits: ["abc"] });
    expect(seen.medium).toBe("class plan lint write-medium state closed");
    expect(seen.full).toBe("class plan validate lint write-full review state closed_reviewed");
    expect(seen.lost).toEqual(["class plan lint write partial", "partial", "quick path: not finished"]);
    expect(seen.lintFail).toEqual(["class plan lint partial", "partial"]);
  });

  it("[sma:k_wq_review] a reviewed quick change gets the review as advice, never a block: the findings travel with the closed result; without a flag there is no review", async () => {
    const seen = await observeD.k_wq_review();
    expect(seen.validate).toEqual([REVIEWED, "closed", 1]);
    expect(seen.full).toEqual(["class plan validate lint write-full review state closed_reviewed", "closed", 1]);
    expect(seen.plain).toEqual([QUICK, 0]);
    expect(seen.policy).toBe("all_or_low_confidence");
  });

  it("[sma:k_wq_verify] --validate and --full verify the change after the write (review, then the row), a plain quick task goes straight to the row; the full flag turns the critics on and quick turns them off", async () => {
    const seen = await observeD.k_wq_verify();
    expect(seen.validate).toEqual([REVIEWED, 0, "done"]);
    expect(seen.full).toEqual(["class plan validate lint write-full review state closed_reviewed", 0]);
    expect(seen.plain).toEqual([QUICK, 0, "quick path: built and verified"]);
    expect(seen.medium).toBe("class plan validate lint write-medium review state closed_reviewed");
    expect(seen.modes.quick).toEqual({ "plan_critique.enabled": false, "code_critique.enabled": false });
    expect(seen.modes.full).toEqual({ "plan_critique.enabled": true, "plan_critique.min_score": 0, "code_critique.enabled": true });
    expect(seen.modes.standard).toEqual({ a: 1 });
  });

  it("[sma:k_wq_state] a finished quick task leaves one table row in STATE.md with its date, task and commit in that order; no STATE.md, no row", () => {
    const seen = observeD.k_wq_state();
    expect(seen.table).toBe(true);
    expect(seen.headings).toBe(1);
    expect(seen.rows).toEqual(["| 2026-11-10 | fix typo | abc123 |", "| 2026-11-11 | fix icon | def456 |"]);
    expect(seen.none).toBeNull();
    expect(seen.unnamed).toBe(true);
  });
});

describe("navigation and session (n1248 … n1252)", () => {
  it("[sma:k_c_help] help names every registered command on a line of its own with its usage, and needs no project", () => {
    const seen = observeD.k_c_help();
    expect(seen.commands).toBeGreaterThan(100);
    expect(seen.missing).toEqual([]);
    expect(seen.firstLine).toBe("bb lane-pilot configure <json>");
    expect(seen.regressLine).toHaveLength(1);
    expect(seen.regressLine[0]).toContain("bb lane-pilot regress [project-id] [--dry-run]");
    expect(seen.regressLine[0]).toContain("   (Regression after acceptance:");
  });

  it("[sma:k_c_progress] the project-life helper that keeps PROGRESS.md after accepted tasks may write the living memory and nothing else; its final line says what it wrote", () => {
    const seen = observeD.k_c_progress();
    expect(seen.inScope).toEqual([]);
    expect(seen.outOfScope).toEqual(["src/app.ts", ".agents/LESSONS.md", "docs/ARCHITECTURE.md", ".agents/decisions/d1.md", ".agents/PROGRESS.md.bak"]);
    expect(seen.final).toEqual({ status: "updated", commit: "a".repeat(40), files: [".agents/PROGRESS.md"] });
    expect(seen.noChange).toEqual({ status: "no_change", commit: null, files: [] });
    expect([seen.idle, seen.busy]).toEqual([true, false]);
    expect(seen.folded).toEqual(["a", "b"]);
    expect([seen.sections, seen.tasksData]).toEqual([true, true]);
  });

  it("[sma:k_c_resume] the PM carries the project-resume skill (and the old name resume-project reads as it), so «where were we» loads the full context restoration", () => {
    const seen = observeD.k_c_resume();
    expect(seen.hasResume).toBe(true);
    expect(seen.skills).toEqual(["karpathy-guidelines", "lane-pilot", "project-life", "project-resume", "project-onboard", "project-design", "web-design", "ui-ux-pro-max", "app-architect", "page-prototype", "metamcp"]);
    expect([seen.alias, seen.canonical, seen.other]).toEqual(["project-resume", "project-resume", "lp-docs"]);
  });

  it("[sma:k_c_pause] pausing a phase writes HANDOFF.json for the machine and PAUSE.md for the person: where it stopped, the pieces, whether the owner's word is awaited and how to resume", async () => {
    const seen = await observeD.k_c_pause();
    expect(seen.files).toEqual([`.agents/phases/${seen.id}/HANDOFF.json`, `.agents/phases/${seen.id}/PAUSE.md`]);
    expect(seen.handoff).toEqual({
      stage: "execution", state: "paused", goal: "hud",
      pieces: [{ id: "p1", taskId: "p1", state: "not issued" }, { id: "p2", taskId: null, state: "not issued" }],
      openQuestions: [], awaitingOwnerWord: null, candidate: null, resume: `lane_pilot_phase {action:"resume", phaseId:"${seen.id}"}`, nextKey: "execution:paused",
    });
    expect(seen.note).toEqual({
      title: `# Пауза — фаза ${seen.id}: Hud`, stage: "Остановились на стадии «исполнение» (execution).", pieces: "Кусочки плана: p1 — not issued; p2 — not issued.",
      how: `Как продолжить: lane_pilot_phase {action:"resume", phaseId:"${seen.id}"} — фаза пойдёт дальше сама.`,
    });
  });

  it("[sma:k_c_plan] the plan stage passes only with an independent critic's approval of a plan built on the signed context; three rounds of changes stop the revising", () => {
    const seen = observeD.k_c_plan();
    expect(seen.approved).toEqual([]);
    expect(seen.none).toBe("no plan: submit the plan's pieces (each a task-v2 contract with a Given/When/Then promise and its wave)");
    expect(seen.noCheck).toEqual(["no independent plan check: run the plan critic (workflow lp.plan) and report its decision with the run's wfRunId"]);
    expect(seen.changes).toEqual(["the plan checker asked for changes: split p1"]);
    expect(seen.notIndependent).toEqual(["the plan check is not proven independent: same thread"]);
    expect(seen.rounds2).toEqual(["the plan checker asked for changes"]);
    expect(seen.rounds3).toEqual(["3 rounds of the plan check asked for changes: stop revising — return the phase to discussion with what the checker keeps finding, or close it", "the plan checker asked for changes"]);
    expect(seen.rounds3ok).toEqual([]);
    expect(seen.onOtherContext).toEqual(["the plan was not built on the signed context (contextSha differs): read the context documents and plan again"]);
    expect(seen.noObjective).toEqual(["the plan names no objective: its goals in one line"]);
    expect(seen.twoRisks).toEqual(["the plan names 2 pre-mortem risk(s): name three to five, each a likely cause of failure a week after merge"]);
  });
});

describe("plan review and the plan stage (n1254 … n1267)", () => {
  it("[sma:k_c_converge] two critics read the plan one after the other and a convergence step decides: approve goes out as approve, anything else as changes requested with the findings and rounds", async () => {
    const seen = await observeD.k_c_converge();
    const findings = [{ severity: "high", text: "split p1" }];
    expect(seen.approved).toEqual(["critic_a critic_b converge approve", { status: "approve", findings, rounds: 2 }]);
    expect(seen.changes).toEqual(["critic_a critic_b converge changes", { status: "changes_requested", findings, rounds: 2 }]);
  });

  it("[sma:k_c_review] the second reviewer is another role than the first and the convergence step reads both reports, so the plan is judged by two independent readers", async () => {
    const seen = await observeD.k_c_review();
    expect(seen.path).toBe("critic_a critic_b converge changes");
    expect(seen.ran).toEqual([1, 1, 1]);
    expect(seen.roles).toEqual(["plan-critic", "specialist-reviewer", "plan-critic"]);
    expect(seen.consumes).toEqual(["critic_a", "critic_b"]);
    expect(seen.out).toEqual({ status: "changes_requested", findings: [{ text: "a" }, { text: "b" }], rounds: 1 });
  });

  it("[sma:k_wp_rubric] the plan stage's rubric: the order of work and what blocks the stage, the same by stage name and by the phase's own stage", async () => {
    const seen = await observeD.k_wp_rubric();
    expect(seen.byStage).toEqual({
      stage: "planning",
      order: ["read CONTEXT.md and SPEC.md", "research where the context leaves a how open", "find the closest code patterns", "cut pieces: one promise, owned paths and a check each", "order them in waves by depends_on", "cover every requirement and locked decision", "independent check, up to three rounds"],
      antipatterns: ["a piece without a check that would fail without it", "a dependency inside one wave", "a requirement no piece covers", "a new file with no analog named", "replanning a closed phase"],
    });
    expect(seen.sameByPhase).toBe(true);
  });

  it("[sma:k_wp_init] stage initialization names what each stage reads before it starts: the roadmap and requirements for the discussion, the signed documents then SPEC, RESEARCH and PATTERNS for planning", () => {
    const seen = observeD.k_wp_init();
    expect(seen.discussion).toEqual([".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md", ".agents/phases/ph_sma/DISCUSSION.md"]);
    expect(seen.planning).toEqual([".agents/phases/ph_sma/CONTEXT.md", ".agents/phases/ph_sma/SECURITY.md", ".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/RESEARCH.md", ".agents/phases/ph_sma/PATTERNS.md"]);
    expect(seen.closed).toEqual([".agents/phases/ph_sma/BOOK.md"]);
    expect(seen.noDocs).toEqual([".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/RESEARCH.md", ".agents/phases/ph_sma/PATTERNS.md"]);
  });

  it("[sma:k_wp_closed] a closed phase is never resumed, paused or replanned: the refusal says to open a new phase, and a new phase opens", async () => {
    const seen = await observeD.k_wp_closed();
    const refusal = (id: string) => `phase ${id} is closed: open a new phase for new work`;
    expect(seen.resumed).toBe(refusal(seen.id));
    expect(seen.paused).toBe(refusal(seen.id));
    expect(seen.replanned).toBe(refusal(seen.id));
    expect(seen.stageOnly).toBe(refusal(seen.id));
    expect(seen.stateOnly).toBe(refusal(seen.id));
    expect([seen.stage, seen.state, seen.newPhase]).toEqual(["closed", "closed", true]);
  });

  it("[sma:k_wp_headless] with nobody to press a key a blocking planning question is filed: it holds the plan gate and the PM's next step until it is answered, a non-blocking or other-stage question does not", () => {
    const seen = observeD.k_wp_headless();
    expect(seen.held).toEqual(["q1"]);
    expect(seen.heldAfterAnswer).toEqual([]);
    expect(seen.gate).toEqual(["open question q1: text q1"]);
    expect(seen.gateAfter).toEqual([]);
    expect(seen.next).toEqual({ waitsForPm: true, key: "planning:questions:q1,q2", text: seen.next.text });
    expect(seen.next.text.startsWith("Phase ph_sma «Sum» — open question(s) at planning: q1 (blocking): text q1; q2: text q2. Answer with lane_pilot_phase {ac")).toBe(true);
    expect(seen.nextAfter).toBe(true);
  });

  it("[sma:k_wp_context] planning reads the signed context documents first, then the spec, the research and the patterns", () => {
    const seen = observeD.k_wp_context();
    expect(seen.firstTwo).toEqual([".agents/phases/ph_sma/CONTEXT.md", ".agents/phases/ph_sma/DISCUSSION.md"]);
    expect(seen.spec).toBe(2);
    expect(seen.planning).toHaveLength(5);
  });

  it("[sma:k_wp_research] research runs only when the flag says so (the daemon's default skips it), never in quick mode, and its notes reach the plan", async () => {
    const seen = await observeD.k_wp_research();
    expect(seen.off).toEqual(["plan", "lint", "plan_critic", "ok"]);
    expect(seen.offResearch).toBe(0);
    expect(seen.on).toEqual(["research", "plan", "lint", "plan_critic", "ok"]);
    expect(seen.planSaw).toEqual({ research_md: "R", patterns_md: "", validation_md: "" });
    expect(seen.quick).toEqual(["plan", "lint", "ok"]);
  });

  it("[sma:k_wp_validation] the validation strategy step runs only when asked, never in quick mode, and its document is given to the plan and returned with it", async () => {
    const seen = await observeD.k_wp_validation();
    expect(seen.off).toEqual(["plan", "lint", "plan_critic", "ok"]);
    expect(seen.on).toEqual(["strategy", "plan", "lint", "plan_critic", "ok"]);
    expect(seen.planSaw).toEqual({ research_md: "", patterns_md: "", validation_md: "V" });
    expect(seen.emitted).toBe("V");
    expect(seen.quick).toEqual(["plan", "lint", "ok"]);
    expect(seen.role).toBe("auditor");
  });

  it("[sma:k_wp_threat] a security risk other than none needs a SECURITY.md among the signed documents, and the plan gate says so", () => {
    const seen = observeD.k_wp_threat();
    const refusal = (risk: string) => `the security risk «${risk}» needs a threat model: write the phase's SECURITY.md (lane-plan template fill SECURITY --phase …) and sign it with the context`;
    expect([seen.none, seen.nope, seen.unset, seen.blank]).toEqual([null, null, null, null]);
    expect(seen.nothing).toBe(refusal("nothing special"));
    expect(seen.risk).toBe(refusal("user tokens leave the box"));
    expect(seen.withModel).toBeNull();
    expect(seen.inGate).toEqual([refusal("user tokens leave the box")]);
  });

  it("[sma:k_wp_uigate] a drawing without UI-SPEC.md or DESIGN.md among its paths has no contract and is refused; a drawing that is not needed or not made yet is not", () => {
    const seen = observeD.k_wp_uigate();
    expect(seen.noContract).toBe("the drawing has no contract: add UI-SPEC.md with the checkable points (screens, states, breakpoints) to the drawing's paths");
    expect([seen.withSpec, seen.withDesign, seen.notNeeded, seen.noDrawing]).toEqual([null, null, null, null]);
    expect(seen.missingSection).toBe("the drawing's contract misses required section(s): texts — UI-SPEC.md needs one heading per required section");
  });

  it("[sma:k_wp_drift] the code map's lag is the number of commits it is behind HEAD, and nothing when it is fresh or unknown; a session start names it", () => {
    const seen = observeD.k_wp_drift();
    expect([seen.behind, seen.same, seen.fresh, seen.noMeta, seen.noHead, seen.fraction, seen.negative]).toEqual([3, 0, 0, 0, 0, 2, 0]);
    expect(seen.text).toBe("Code map is 3 commits behind HEAD: reindex before relying on it");
    expect(seen.none).toBeNull();
  });

  it("[sma:k_wp_patterns] the pattern search runs only when asked, never in quick mode, and its document reaches the plan and comes back with it", async () => {
    const seen = await observeD.k_wp_patterns();
    expect(seen.off).toEqual(["plan", "lint", "plan_critic", "ok"]);
    expect(seen.on).toEqual(["patterns", "plan", "lint", "plan_critic", "ok"]);
    expect(seen.planSaw).toEqual({ research_md: "", patterns_md: "P", validation_md: "" });
    expect(seen.emitted).toBe("P");
    expect(seen.quick).toEqual(["plan", "lint", "ok"]);
  });

  it("[sma:k_wp_planner] the planner step is a planner role that writes the plan, is sent back with the contract linter's errors up to three tries, then fails; an already met goal plans nothing and a plan of three tasks gets the critic", async () => {
    const seen = await observeD.k_wp_planner();
    expect([seen.role, seen.maxVisits, seen.modeInput]).toEqual(["planner", 4, "fresh"]);
    expect(seen.bad).toEqual([["plan", "lint", "plan", "lint", "plan", "lint", "failed"], 3, 0, "failed"]);
    expect(seen.fixed).toEqual([["plan", "lint", "plan", "lint", "ok"], [{ research_md: "", patterns_md: "", validation_md: "" }, { gaps: ["a: owns_paths overlap"] }], "ok"]);
    expect(seen.gaps).toEqual([["plan", "lint", "ok"], { research_md: "", patterns_md: "", validation_md: "" }, "ok"]);
    expect(seen.already).toEqual([["plan", "lint", "ok"], true, 0]);
    expect(seen.big).toEqual([["plan", "lint", "plan_critic", "ok"], 3, "pass"]);
  });
});
