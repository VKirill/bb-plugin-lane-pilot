// Region 16 (slash commands and workflows), batch c: the verify-work cards, the debug session, and the stand-alone commands (n1205 … n1236, without n1224 and n1230).
// Every test runs the real code of the node through tests/sma/r16-world-c.ts (the same observations the scene scripts/lp_drill/scenes/sma_r16_c.py proves) and checks the
// result the card names: what a graph step wrote, where the run went next, what the next step received, what was refused. The graphs run on the real engine with the
// model and owner steps stubbed.
import { describe, expect, it, vi } from "vitest";
import { observeC } from "./r16-world-c";

vi.setConfig({ testTimeout: 180_000 });

describe("verify-work (n1205 … n1213)", () => {
  it("[sma:k_wv_design] only checklist items of the drawing's contract are points, each with a stable id from its text, a repeated line counts once, at most 40 are kept and the cut is counted", () => {
    const seen = observeC.k_wv_design();
    expect(seen.total).toBe(46);
    expect(seen.kept).toBe(40);
    expect(seen.first).toEqual({ id: "design_6c4c7e24", text: "point 1: the screen shows 1" });
    expect(seen.last).toBe("point 40: the screen shows 40");
    expect(seen.idLooksRight).toBe(true);
    expect(seen.ids).toBe(40);
    expect(seen.small).toEqual(["one", "two"]);
    expect(seen.smallTotal).toBe(2);
    expect(seen.stable).toBe(true);
  });

  it("[sma:k_wv_extract] tests are derived from a finished phase, the owner agrees (a timeout blocks the run) and the writer works after his answer; a list of gaps given by hand skips both", async () => {
    const seen = await observeC.k_wv_extract();
    expect(seen.agreed).toEqual({ path: ["derive", "confirm", "baseline", "write_tests", "run", "inventory", "done"], status: "done", added: 3, fromDerive: "baseline#1" });
    expect(seen.timeout).toEqual({ path: ["derive", "confirm", "blocked"], status: "blocked" });
    expect(seen.given).toEqual({ path: ["derive", "confirm", "baseline", "write_tests", "run", "inventory", "done"], skipped: ["derive", "confirm"], status: "done" });
  });

  it("[sma:k_wv_uatfile] the acceptance file marks each test open, passed or failed with the person's note, and a fresh read of the text gives back the same state", () => {
    const seen = observeC.k_wv_uatfile();
    expect(seen.bare).toEqual(["- [ ] 1. p1: given g, when w, then then-p1", "- [ ] 2. p2: given g, when w, then then-p2", "- [ ] 3. p3: given g, when w, then then-p3"]);
    expect(seen.answered).toEqual(["- [x] 1. p1: given g, when w, then then-p1", "- [!] 2. p2: given g, when w, then then-p2 — the total is wrong", "- [ ] 3. p3: given g, when w, then then-p3"]);
    expect(seen.head).toEqual(["# UAT — phase ph_sma: Sum", "", "Goal: sums"]);
    expect(seen.readBack).toEqual({ lines: 3, passed: 1, failed: ["2. p2: given g, when w, then then-p2 — the total is wrong"], open: ["3. p3: given g, when w, then then-p3"] });
    expect(seen.readBare).toMatchObject({ lines: 3, passed: 0, failed: [] });
    expect(seen.readBare.open).toHaveLength(3);
    expect(seen.main).toBe("Test the work on main.");
    expect(seen.rule).toBe("One line per test, answered by its number with uat_line (pass or fail). The phase is accepted only when every line passed.");
  });

  it("[sma:k_wv_present] a person answers one test at a time by its number; the answer, his note and who gave it are recorded on the phase and in its book; a number that does not exist and a phase with no session are refused", async () => {
    const seen = await observeC.k_wv_present();
    expect(seen.lines).toEqual([{ n: 1, state: "open", note: null, by: null }, { n: 2, state: "passed", note: null, by: "owner via screen" }, { n: 3, state: "failed", note: "the total   is wrong", by: "owner" }]);
    expect(seen.book).toEqual(["UAT line 2 (p2): pass by owner via screen", "UAT line 3 (p3): fail —   the total   is wrong  by owner"]);
    expect(seen.redone).toEqual({ state: "passed", note: null });
    expect(seen.unknown).toBe("no UAT line 9: the lines are 1 to 3");
    expect(seen.noSession).toMatch(/has no UAT lines yet: they are numbered when the UAT session opens at acceptance$/);
  });

  it("[sma:k_wv_complete] the owner's yes closes the session only when every line passed; an open or a failed line (or no lines) refuses it with the count", async () => {
    const seen = await observeC.k_wv_complete();
    const why = (open: number, failed: number, all: number) => `UAT is not complete: ${open} open, ${failed} failed of ${all} — the owner answers each line by its number (uat_line)`;
    expect(seen.open).toEqual({ why: why(1, 0, 3), stage: "acceptance", words: [] });
    expect(seen.failed).toEqual({ why: why(0, 1, 3), stage: "acceptance", words: [] });
    expect(seen.none).toEqual({ why: why(0, 0, 0), stage: "acceptance", words: [] });
    expect(seen.all).toEqual({ why: null, stage: "acceptance", words: [["uat", "yes"]] });
  });

  it("[sma:k_wv_diagnose] a failed verification is diagnosed first: one debugger per gap, and the causes come back together, each with its gap, before anything is planned", async () => {
    const seen = await observeC.k_wv_diagnose();
    expect(seen.path).toEqual(["ask_symptoms", "normalize", "diagnose", "diagnosed"]);
    expect(seen.skipped).toEqual(["ask_symptoms"]);
    expect(seen.status).toBe("confirmed");
    expect(seen.count).toBe(3);
    expect(seen.causes).toEqual(["cause 1", "cause 2", "cause 3"]);
    expect(seen.gaps).toEqual(["check p1 red: lint fails", "check p2 red: the total is wrong", "check p3 red: timeout"]);
    expect(seen.single).toEqual(["ask_symptoms", "normalize", "diagnose", "diagnosed"]);
  });

  it("[sma:k_wv_gapplan] the findings of a review go to the planner in its gap mode as the gaps, the goal unchanged, and its plan goes to the build; a second review's findings go the same way", async () => {
    const seen = await observeC.k_wv_gapplan();
    expect(seen.plan).toEqual({ goal: "Fix review findings", mode: "gaps", gaps: [{ file: "src/a.ts", line: 12, severity: "high", evidence: "return value of save() ignored" }] });
    expect(seen.build).toEqual({ tasks: [{ id: "f1", objective: "f1", depends_on: [] }], waves: [] });
    expect(seen.plan2).toEqual({ goal: "Fix review findings", mode: "gaps", gaps: [{ file: "src/b.ts", line: 3, severity: "medium", evidence: "empty catch" }] });
    expect(seen.path).toEqual(["first_review", "plan_fix", "build_fix", "re_review", "plan_fix2", "build_fix2", "re_review", "done"]);
    expect(seen.status).toBe("done");
  });

  it("[sma:k_wv_gapcheck] a plan of three or more tasks is checked as a whole by the plan critic, a role other than the planner; a smaller plan in the standard mode and any plan in the quick mode go on unchecked", async () => {
    const seen = await observeC.k_wv_gapcheck();
    expect(seen.big).toEqual({ path: ["plan", "lint", "plan_critic", "ok"], verdict: "pass", status: "ok" });
    expect(seen.small).toEqual({ path: ["plan", "lint", "ok"], verdict: null });
    expect(seen.quick).toEqual(["plan", "lint", "ok"]);
    expect(seen.roles).toEqual(["planner", "plan-critic"]);
  });

  it("[sma:k_wv_revision] a critic's concerns send the plan back to the planner with its findings as the gaps and the revised plan is checked again; a critic that never agrees stops the loop after three checks as low confidence", async () => {
    const seen = await observeC.k_wv_revision();
    expect(seen.fixed.path).toEqual(["plan", "plan_critic", "plan", "plan_critic", "ok"]);
    expect(seen.fixed.handed).toEqual([null, [{ id: "c1", severity: "high", file: "PLAN", line: 1, evidence: "t2 depends on a task that does not exist" }]]);
    expect(seen.fixed).toMatchObject({ verdict: "pass", status: "ok" });
    expect(seen.endless).toEqual({ plans: 3, critics: 3, status: "low_confidence" });
  });
});

describe("debugging (n1214, n1218 … n1222)", () => {
  it("[sma:k_c_debug] a debugging run keeps its session file, reports a cause only when the evidence gate holds (a weak cause is looked at once more, then reported inconclusive), and in the full mode a fresh agent re-checks the cause and an objection sends it back", async () => {
    const seen = await observeC.k_c_debug();
    expect(seen.sure.path).toEqual(["session", "investigate", "write_investigation_session", "write_investigation_evidence", "confirmed"]);
    expect(seen.sure).toMatchObject({ status: "confirmed", root: "the last empty line yields an undefined row", files: ["src/import/csv.ts:48"], confidence: 82 });
    expect(seen.sure.session).toEqual(["# Debug session — csv-crash", "", "Status: open", ""]);
    expect(seen.second).toEqual({ path: ["session", "investigate", "write_investigation_session", "write_investigation_evidence", "verify_cause", "write_verification_session", "write_verification_evidence", "confirmed"], status: "confirmed" });
    expect(seen.weak).toEqual({ path: ["session", "investigate", "write_investigation_session", "write_investigation_evidence", "investigate", "write_investigation_session", "write_investigation_evidence", "inconclusive"], status: "inconclusive" });
    expect(seen.objection).toEqual({ path: ["session", "investigate", "write_investigation_session", "write_investigation_evidence", "verify_cause", "write_verification_session", "write_verification_evidence", "investigate", "write_investigation_session", "write_investigation_evidence", "verify_cause", "write_verification_session", "write_verification_evidence", "confirmed"], status: "confirmed" });
  });

  it("[sma:k_wdb_list] the runs of a workflow are listed newest first with each run's status, one page at a time (the page says whether more follow), only for the project asked", async () => {
    const seen = await observeC.k_wdb_list();
    expect(seen.all).toEqual({ runs: [["r5", "succeeded"], ["r4", "running"], ["r2", "failed"], ["r1", "succeeded"]], hasMore: false });
    expect(seen.mine).toEqual({ runs: [["r4", "running"], ["r2", "failed"], ["r1", "succeeded"]], hasMore: false });
    expect(seen.page).toEqual({ runs: [["r5", "succeeded"], ["r4", "running"]], hasMore: true });
    expect(seen.next).toEqual({ runs: [["r2", "failed"], ["r1", "succeeded"]], hasMore: false });
    expect(seen.exact).toEqual({ runs: [["r5", "succeeded"], ["r4", "running"], ["r2", "failed"], ["r1", "succeeded"]], hasMore: false });
    expect(seen.nobody).toEqual({ runs: [], hasMore: false });
  });

  it("[sma:k_wdb_continue] with a session named and no symptom the investigation resumes from the file the earlier run left: nobody is asked the symptoms again and the file is not overwritten", async () => {
    const seen = await observeC.k_wdb_continue();
    expect(seen.path).toEqual(["session", "investigate", "write_investigation_session", "write_investigation_evidence", "confirmed"]);
    expect(seen.skipped).toContain("ask_symptoms");
    expect(seen.asked).toBe(0);
    expect(seen.status).toBe("confirmed");
    expect(seen.kept).toBe(true);
    // startsWith alone is not proof: the session file must be the old bytes plus exactly the appended session entry.
    expect(seen.appended).toBe(true);
  });

  it("[sma:k_wdb_symptoms] a problem described in a few words is asked for the five things and the answer goes on to the investigator; an already full description, a list of failures and a resumed session are not asked", async () => {
    const seen = await observeC.k_wdb_symptoms();
    expect(seen.short).toEqual({ path: ["ask_symptoms", "investigate", "confirmed"], status: "confirmed" });
    expect(seen.handed).toBe("ask_symptoms#1");
    expect(seen.long).toEqual({ path: ["investigate", "confirmed"], skipped: true });
    expect(seen.failures).toEqual(["normalize", "diagnose", "diagnosed"]);
  });

  it("[sma:k_wdb_setup] a new session is a file under .agents/planning/debug named by a safe slug, started with the symptom and the status open; a hostile name stays inside that folder; no name, no file", async () => {
    const seen = await observeC.k_wdb_setup();
    expect(seen.path).toEqual(["session", "investigate", "write_investigation_session", "write_investigation_evidence", "confirmed"]);
    expect(seen.file).toBe("# Debug session — csv-crash\n\nStatus: open\n\n## Symptom\n\nthe import crashes on files with an empty last line, since v2.3\n\n## Hypotheses\n\n## Evidence\n\n## Root cause\n\n## Fix directions\n- h1: fresh entry\n");
    expect(seen.hostile).toEqual({ path: ["session", "investigate", "write_investigation_session", "write_investigation_evidence", "confirmed"], escaped: false, kept: true });
    expect(seen.none).toEqual(["investigate", "confirmed"]);
  });

  it("[sma:k_wdb_manager] the debuggers of each failure and the re-check run in sessions of their own and the calling chat receives only the summary: status, cause, confidence, files, direction, tests, risks, evidence path", async () => {
    const seen = await observeC.k_wdb_manager();
    expect(seen.keys).toEqual(["affected_files", "confidence", "diagnosis", "evidence_path", "fix_direction", "fix_directions", "regression_tests", "risks", "root_cause", "status"]);
    expect(seen.out).toEqual({ status: "confirmed", root_cause: "rc", confidence: 82, affected_files: ["a.ts:1"], fix_direction: "fd", regression_tests: ["t"], risks: ["r"], evidence_path: "", fix_directions: ["fd"], diagnosis: "mech" });
    expect(seen.fanout).toEqual([["diagnose:child", "new"], ["diagnose:child", "new"]]);
    expect(seen.manyKeys).toEqual(["diagnoses", "status"]);
  });
});

describe("the stand-alone commands (n1215 … n1236)", () => {
  it("[sma:k_c_forensics] the post-mortem of a task lists, from the hub's own records, when it arrived, each attempt and its moves with the reason, its stage receipts and baseline verdicts; an unknown task is an empty line", () => {
    const seen = observeC.k_c_forensics();
    expect([...seen.entries].sort()).toEqual([
      "attempt: attempt 1 created", "baseline: baseline red → kept: main was red too", "edition: contract edition 1 (created) · sha <12>",
      "move: attempt 1: queued → spawn_requested", "move: attempt 1: running → blocked: verification_failed: npm test", "move: attempt 1: spawn_requested → running",
      "stage: stage verification failed (attempt 1)", "task: task arrived (pm)",
    ]);
    expect(seen.entries.filter((row) => row.startsWith("move: "))).toEqual(["move: attempt 1: queued → spawn_requested", "move: attempt 1: spawn_requested → running", "move: attempt 1: running → blocked: verification_failed: npm test"]);
    expect(seen.entries[0]).toBe("task: task arrived (pm)");
    expect(seen.entries.at(-1)).toBe("baseline: baseline red → kept: main was red too");
    expect(seen.sorted).toBe(true);
    expect(seen.receipts).toEqual([["verification", "failed", 1]]);
    expect(seen.birth).toBe("pm");
    expect(seen.none).toEqual({ runId: null, entries: 0 });
  });

  it("[sma:k_c_health] the planning files' integrity names per area the index entry whose folder is gone and the item missing from its index, leaves prose alone and omits a healthy area; the fix drops the dead entry, adds the missing one and keeps a backup", () => {
    const seen = observeC.k_c_health();
    expect(seen.report).toEqual([
      { area: "todos", missingInIndex: ["unlisted"], deadIndexLines: ["- ghost-item — the folder was deleted"] },
      { area: "plans", missingInIndex: ["2026-11-02-new-plan"], deadIndexLines: [] },
    ]);
    expect(seen.fixed).toEqual(["todos/INDEX.md: +1 -1 (the text before is in INDEX.md.bak)", "plans/INDEX.md: +1 -0 (the text before is in INDEX.md.bak)"]);
    expect(seen.todos).toBe("# Todos\n\n- real-one — the live item\n- Remember to review this weekly\n\n## Notes\nghost-prose: a sentence, not an entry\n- unlisted\n");
    expect(seen.todosBak).toBe(true);
    expect(seen.plans).toBe("# Plans\n- 2026-11-01-big-plan\n- 2026-11-02-new-plan\n");
    expect(seen.after).toEqual([]);
  });

  it("[sma:k_c_undo] undo is a git revert of the task's merge in a scratch worktree, merged like a writer merge: history grows, nothing is reset, a second undo is refused, and a revert that collides with later work is refused naming the later task with main left alone", async () => {
    const seen = await observeC.k_c_undo();
    expect(seen.first.result).toMatchObject({ ok: true, state: "merged", next: null });
    expect(seen.first.result.summary).toMatch(/^revert of t1 \(\w{10}\) is clean: 1 file\(s\) restored, 1\/1 task checks green$/);
    expect(seen.first).toMatchObject({ libGone: true, clean: true, subject: "Merge writer work: Revert t1", keepsMerge: true, worktrees: 1 });
    expect(seen.again).toEqual({ ok: false, state: "refused", summary: "task t1 was already reverted in <sha>", next: "nothing to do", conflicts: null });
    expect(seen.collide.collide).toMatchObject({ ok: false, state: "refused", summary: "reverting <sha> conflicts in server.ts", conflicts: ["server.ts"] });
    expect(seen.collide.collide.next).toContain("Revert `bb lane-pilot revert t3` first");
    expect(seen.collide).toMatchObject({ mainKept: true, text: "line1 from t3\nline2\nline3\n", worktrees: 1 });
    expect(seen.order).toEqual(["merged", "merged"]);
    expect(seen.back).toBe("line1\nline2\nline3\n");
    expect(seen.noTask).toMatchObject({ ok: false, state: "refused", summary: "no task or attempt \"nope\" in Lane Pilot's records" });
  });

  it("[sma:k_c_docsupdate] a docs unit is written by the docs agent and checked against the code before it is committed: a skipped check is never committed, nothing to do ends before the agent, and the commit receives the checked result", async () => {
    const seen = await observeC.k_c_docsupdate();
    expect(seen.whole).toEqual({ path: ["prepare", "write", "verify", "commit", "done"], row: { state: "passed", pages: 3 }, commitGot: "verify#1" });
    expect(seen.unverified).toEqual({ path: ["prepare", "write", "verify", "skipped-verify"], row: { state: "skipped", why: "the check could not run" } });
    expect(seen.idle).toEqual({ path: ["prepare", "skipped-prepare"], wrote: 0 });
  });

  it("[sma:k_c_sessreport] the report of the work done and spent counts the day's tasks of live projects by outcome, keeps the sandbox and old versions apart, gives the measured usage and says where to look further", async () => {
    const seen = await observeC.k_c_sessreport();
    expect(seen.head).toBe("📊 Lane Pilot за сутки. счёт с 20");
    expect(seen.done).toBe("2 задач, принято 1 (50.0%)");
    expect(seen.lpErrors).toBe("1");
    expect(seen.outside).toBe("песочницы 1, старые версии 0");
    expect(seen.sandbox).toBe("1 попыток, принято 100.0%");
    expect(seen.old).toBe("0 попыток, принято 0%");
    expect(seen.usage).toBe("no writer thread 0/2");
    expect(seen.where).toBe(true);
    expect(seen.oldAttemptCounted).toBe(false);
  });

  it("[sma:k_c_stats] the project's report counts its phases and the pieces of their plans by state, what the accepted merges changed (commits and files) and the timeline, only for that project", async () => {
    const seen = await observeC.k_c_stats();
    expect(seen.phases).toEqual([["first", "execution", "active"], ["second", "planning", "active"]]);
    expect(seen.plans).toEqual({ pieces: 5, accepted: 2, withdrawn: 2 });
    expect(seen.requirements).toEqual({ covered: 0, total: 0 });
    expect(seen.git).toEqual({ commits: 1, files: 3 });
    expect(seen.timeline).toEqual(["accepted: T1"]);
    expect(seen.days).toBe(30);
    expect(seen.other).toEqual({ phases: 0, plans: { pieces: 0, accepted: 0, withdrawn: 0 }, git: { commits: 0, files: 0 } });
  });

  it("[sma:k_c_explore] an idea is questioned against the code before any plan: what the code settles is locked, what it cannot is left open and the run ends open with the risks; nothing open ends done; questions without a code anchor send the walk back once", async () => {
    const seen = await observeC.k_c_explore();
    expect(seen.open.path).toEqual(["walk", "synth", "open"]);
    expect(seen.open.out).toEqual({ status: "open", locked: ["GET only"], open: ["invalidation on write"], deferred: [], risk_register: [{ risk: "stale reads", severity: "high" }], terminology: [{ term: "cache", meaning: "the API cache" }], branches_walked: 5 });
    expect(seen.done).toEqual({ path: ["walk", "synth", "done"], status: "done", deferred: ["metrics"] });
    expect(seen.again).toEqual({ path: ["walk", "walk", "synth", "done"], walks: 2 });
  });

  it("[sma:k_c_spike] a spike that answered its question and passed the check is reported answered with its decision and file; an experiment that did not answer, or a result that fails the check, is inconclusive and keeps no skill draft", async () => {
    const seen = await observeC.k_c_spike();
    expect(seen.ok).toEqual({ path: ["spike_new", "experiment", "write_spike", "write_skill", "goal_check", "answered"], out: { status: "answered", decision: "yes, fts5 handles 1M rows", spike_path: "spikes/fts.md", skill_draft: "draft.md", skill_path: "" } });
    expect(seen.failed).toEqual({ path: ["spike_new", "experiment", "write_spike", "write_skill", "goal_check", "inconclusive"], status: "inconclusive", draft: "" });
    expect(seen.none).toEqual({ path: ["spike_new", "experiment", "write_spike", "write_skill", "inconclusive"], status: "inconclusive", draft: "" });
  });

  it("[sma:k_c_quick] a small issue goes the short way — class, one task from the planner, the writer, a row in STATE, closed; a plan of several tasks or a high risk is proposed to the full chain and writes nothing; a failed writer ends it partial", async () => {
    const seen = await observeC.k_c_quick();
    expect(seen.short.path).toEqual(["class", "plan", "lint", "write", "state", "closed"]);
    expect(seen.short.out).toEqual({ status: "closed", severity: "low", resolution: "fixed", comment: "quick path: built and verified", merged_commits: ["q1"] });
    expect(seen.short.stateGot).toBe("Typo in button label");
    expect(seen.several).toEqual({ path: ["class", "plan", "escalate", "proposed"], status: "proposed", wrote: 0 });
    expect(seen.risky).toEqual({ path: ["class", "plan", "escalate", "proposed"], status: "proposed", wrote: 0 });
    expect(seen.failed).toEqual({ path: ["class", "plan", "lint", "write", "partial"], status: "partial" });
    expect(seen.row).toEqual(["| date | task | commit |", "| --- | --- | --- |", "| 2026-11-10 | Typo in button label | q1 |"]);
    expect(seen.rows2).toBe(4);
    expect(seen.none).toBeNull();
  });

  it("[sma:k_c_fastc] a trivial task runs inline — one self-check and one task, no plan and no review; a task that is not concrete, bounded and single is sent to the full chain and writes nothing; a task the writer could not land is reported blocked", async () => {
    const seen = await observeC.k_c_fastc();
    expect(seen.done).toEqual({ path: ["self_check", "task", "done"], out: { status: "done", merge_commit: "c0ffee1", files: [".gitignore"], summary: "one named file" } });
    expect(seen.big).toEqual({ path: ["self_check", "reroute", "rerouted"], out: { status: "rerouted", proposed_workflow: "analyze-plan-execute", summary: "spans three modules" }, wrote: 0 });
    expect(seen.failed).toEqual({ path: ["self_check", "task", "blocked"], status: "blocked" });
  });

  it("[sma:k_c_do] a request in free words is only routed: to a workflow with the rule that decided it, to up to three questions when it is vague, or told that «continue» is not a workflow; the work is never started", async () => {
    const seen = await observeC.k_c_do();
    expect(seen.full).toEqual({ decision: "route", workflowId: "issue-full", questions: 0, rule: "tracker-ref" });
    expect(seen.quick).toEqual({ decision: "route", workflowId: "issue-quick", questions: 0, rule: "tracker-ref" });
    expect(seen.debug).toEqual({ decision: "route", workflowId: "debug", questions: 0, rule: "ui-words" });
    expect(seen.vague).toEqual({ decision: "clarify", workflowId: null, questions: 3, rule: null });
    expect(seen.cont).toEqual({ decision: "clarify", workflowId: null, questions: 1, rule: "state_continue" });
    expect(seen.short).toEqual({ decision: "route", workflowId: "deploy", questions: 0, rule: null });
  });

  it("[sma:k_c_autonomous] with autonomous on a closed phase opens the next open roadmap row (never a parked one) as the next phase at its discussion and tells the PM nothing; off, the PM is told which row is next and nothing is opened", async () => {
    const seen = await observeC.k_c_autonomous();
    expect(seen.on).toEqual({ next: [["Menu", "discussion", "1.2"]], book: ["autonomous: the next phase <id> «Menu» (roadmap 1.2) is open"], told: [], closed: "closed" });
    expect(seen.off.next).toEqual([]);
    expect(seen.off.book).toEqual([]);
    expect(seen.off.told).toHaveLength(1);
    expect(seen.off.told[0]).toMatch(/^\[Lane Pilot phase\] Phase <id> «Hud» is closed\. Next on the roadmap: 1\.2 «Menu» — the menu\./);
    expect(seen.lastRow).toEqual({ next: [], book: [], told: [], closed: "closed" });
  });

  it("[sma:k_c_manager] the PM at the console is told the one step the phase needs now, once per step and not on every pass, a new step as soon as the phase moves, and a busy PM is not queued a step", async () => {
    const seen = await observeC.k_c_manager();
    expect([seen.idle.first, seen.idle.second, seen.idle.third]).toEqual([1, 1, 2]);
    expect(seen.idle.texts[0]).toMatch(/^\[Lane Pilot phase\] Phase <id> «Hud» — stage 2, planning/);
    expect(seen.idle.texts[1]).toMatch(/^\[Lane Pilot phase\] Phase <id> «Hud» — stage 6, acceptance/);
    expect([seen.busy.first, seen.busy.second, seen.busy.third]).toEqual([0, 0, 0]);
  });
});
