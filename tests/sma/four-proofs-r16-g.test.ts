// Region 16 (slash commands and workflows), batch g: the milestone close, summary and audit, new milestone, cleanup, ship (gate, preflight, vendor updates, push, PR, review, track,
// post-ship hooks), deploy, project start and new project, code analysis — n1330 … n1348. Every test runs the real graph file on the real engine (model steps answer from a table) through
// tests/sma/r16-world-g.ts (the same observations the scene scripts/lp_drill/scenes/sma_r16_g.py proves) and checks the result the card names: the path a run took, what it emitted,
// which step was never reached.
import { describe, expect, it } from "vitest";
import { observeG } from "./r16-world-g";

const FULL_CLOSE = ["status", "retro", "living", "close", "summary", "approve_knowledge", "record", "snapshot", "archive", "closed"];
const SHIPPED = ["gate", "preflight", "open_pr", "hooks", "goal_check", "shipped"];

describe("milestone close, summary, audit, new milestone, cleanup (n1330 … n1334, n1346)", () => {
  it("[sma:k_c_completems] closing a milestone writes its record, snapshots the roadmap and refreshes PROJECT.md only when it exists; with the switches off none of the three happens", async () => {
    const seen = await observeG.k_c_completems();
    expect(seen.onPath).toEqual(FULL_CLOSE);
    expect(seen.offPath).toEqual(["status", "retro", "close", "approve_knowledge", "archive", "closed"]);
    expect([seen.onRecordCalled, seen.onSnapshotCalled, seen.offRecordCalled, seen.offSnapshotCalled]).toEqual([1, 1, 0, 0]);
    expect(seen.recordPath).toBe(".agents/milestones/{{$inputs.run_id}}.md");
    expect(seen.recordReads).toEqual(["status", "retro.insights", "close.staged", "close.report_path", "$inputs.goal", "$inputs.goals"]);
    expect(seen.snapshotName).toBe("{{$inputs.goal}}");
    expect(seen.retroPrompt).toMatch(/If \.agents\/planning\/PROJECT\.md already exists, append this milestone's changed limits to it/);
    expect(seen.retroPrompt).toMatch(/only if the file already exists; never create it/);
    expect(seen.onOut).toMatchObject({ status: "closed", candidates_staged: 2, candidates_approved: 1, deferred: false, report_path: "reports/close.md" });
  });

  it("[sma:k_c_mssummary] the summary is its own graph (summary, goal check, done) and the close runs it after a successful close only with milestone.summary on", async () => {
    const seen = await observeG.k_c_mssummary();
    expect(seen.alonePath).toEqual(["summary", "goal_check", "done"]);
    expect(seen.aloneOut).toEqual({ status: "done", summary_path: ".agents/planning/MILESTONE-SUMMARY.md", open_items: ["docs"] });
    expect(seen.sources).toBe(true);
    expect(seen.keepsEarlier).toBe(true);
    expect(seen.onPath).toEqual(FULL_CLOSE);
    expect(seen.offPath).toEqual(["status", "retro", "living", "close", "approve_knowledge", "record", "snapshot", "archive", "closed"]);
    expect(seen.haltedPath).toEqual(["status", "retro", "living", "close", "halted"]);
    expect(seen.haltedStatus).toBe("halted");
    expect(seen.summaryCalls).toEqual([1, 0, 0]);
  });

  it("[sma:k_c_auditms] a close with open or unlanded work, a red gate, a running attempt or an uncovered requirement stops for the owner and names the readings; a clear one is not asked", async () => {
    const seen = await observeG.k_c_auditms();
    expect(seen.clear).toMatchObject({ asked: 0, status: "closed", uncovered: [], gate: "green", unmergedSeen: 0 });
    expect(seen.clear.path).toEqual(FULL_CLOSE);
    expect(seen.open).toMatchObject({ asked: 1, status: "not_ready", path: ["status", "ask_finish", "not_ready"] });
    expect(seen.uncovered).toMatchObject({ asked: 1, status: "not_ready", uncovered: ["REQ-2"] });
    expect(seen.red).toMatchObject({ asked: 1, status: "not_ready", gate: "red" });
    expect(seen.unlanded).toMatchObject({ asked: 1, status: "not_ready", unmergedSeen: 1 });
    expect(seen.running).toMatchObject({ asked: 1, status: "not_ready" });
    expect(seen.timeout).toMatchObject({ asked: 1, status: "not_ready" });
    // close anyway: the answer lets the close go on with the coverage gap named in the result.
    expect(seen.anyway).toMatchObject({ asked: 1, status: "closed", uncovered: ["REQ-2"] });
    expect(seen.anyway.path.slice(0, 3)).toEqual(["status", "ask_finish", "retro"]);
    expect(seen.prompt).toContain("uncovered requirements (no phase covering them, marked —) are named in the question");
    expect(seen.prompt).toContain("{{status.coverage_matrix}}");
  });

  it("[sma:k_c_msgaps] a new milestone started from the audit's gaps archives the old one, then frames its phases; what the run emits is the phases the frame wrote", async () => {
    const seen = await observeG.k_c_msgaps();
    expect(seen.path).toEqual(["archive", "frame", "done"]);
    expect(seen.out).toEqual({ status: "done", phases: ["1 coverage of REQ-2", "2 the gate"] });
    expect(seen.frameGoal).toBe(1);
    expect(seen.framePrompt).toContain("phases in order (lane-plan phase add <name> --goal …)");
  });

  it("[sma:k_c_cleanup] cleanup only lists while the plan is not applied (planned), moves the folders and checks the goal when applied (done), and blocks when the goal check fails; dry run is the default", async () => {
    const seen = await observeG.k_c_cleanup();
    expect(seen.dryRun).toBe(true);
    expect(seen.dry).toEqual({ path: ["plan", "planned"], out: { status: "planned", moved: ["phases/ph_old"] } });
    expect(seen.applied).toEqual({ path: ["plan", "goal_check", "done"], out: { status: "done", moved: ["phases/ph_old"] } });
    expect(seen.failed).toEqual({ path: ["plan", "goal_check", "blocked"], out: { status: "blocked" } });
    expect(seen.prompt).toContain("With dry_run false, archive the phase folders under .agents/planning/milestones/archive/");
    expect(seen.prompt).toContain("never touch an open phase");
  });

  it("[sma:k_c_newmilestone] a new milestone archives the previous one first, then frames goals, requirements and phases; the run ends done with the phases", async () => {
    const seen = await observeG.k_c_newmilestone();
    expect(seen.entry).toBe("archive");
    expect(seen.path).toEqual(["archive", "frame", "done"]);
    expect(seen.archiveFirst).toBe(true);
    expect([seen.archiveCalls, seen.frameCalls]).toEqual([1, 1]);
    expect(seen.out).toEqual({ status: "done", phases: ["1 coverage of REQ-2", "2 the gate"] });
    expect(seen.framePrompt).toContain("3–7 requirements with ids into REQUIREMENTS.md");
  });
});

describe("ship (n1335 … n1343)", () => {
  it("[sma:k_ws_preflight] only a passed status ships: a preflight that is not ready holds the ship with its reasons and nothing is pushed", async () => {
    const seen = await observeG.k_ws_preflight();
    expect(seen.ready.path).toEqual(SHIPPED);
    expect(seen.ready.out).toEqual({ status: "shipped", pr_url: "https://git.example/pr/7", held_by: [], hooks_failed: [] });
    expect(seen.held.path).toEqual(["gate", "preflight", "held"]);
    expect(seen.held.out).toEqual({ status: "held", pr_url: "", held_by: ["verification is not passed: acceptance line 2 does not hold"], hooks_failed: [] });
    expect([seen.held.prCalls, seen.ready.prCalls]).toEqual([0, 1]);
    expect(seen.prompt).toMatch(/^Verification passed\? \(lane_pilot_phase status: acceptance lines all hold\)\./);
  });

  it("[sma:k_ws_fullgate] the full-gate mark holds the ship unless the newest gate run passed on this head within six hours; a held ship names the reason", async () => {
    const seen = await observeG.k_ws_fullgate();
    expect(seen.windowHours).toBe(6);
    expect(seen.none).toEqual({ ok: false, reason: "no integration gate run is recorded" });
    expect(seen.fresh).toEqual({ ok: true, reason: "green on aaaaaaaaaaaa within six hours" });
    expect(seen.edge.ok).toBe(true);
    expect(seen.stale).toEqual({ ok: false, reason: "the gate's green mark is older than six hours (on aaaaaaaaaaaa)" });
    expect(seen.wrongHead.ok).toBe(false);
    expect(seen.wrongHead.reason).toContain("not on the head being shipped aaaaaaaaaaaa");
    expect(seen.unknownHead.ok).toBe(true);
    expect(seen.red.ok).toBe(false);
    expect(seen.running.ok).toBe(false);
    expect(seen.blocked.path).toEqual(["gate", "held_gate"]);
    expect(seen.blocked.out).toEqual({ status: "held", pr_url: "", held_by: ["the gate's green mark is older than six hours (on aaaaaaaaaaaa)"], hooks_failed: [] });
    expect(seen.blocked.preflightCalls).toBe(0);
  });

  it("[sma:k_ws_vendor] no release ships past an untriaged update: the preflight names it among the held items, the ship is held and no PR is opened; a clean preflight holds nothing", async () => {
    const seen = await observeG.k_ws_vendor();
    expect(seen.status).toBe("held");
    expect(seen.heldBy).toEqual(["verification is not passed", "untriaged vendor update: lodash 4.17.21 → 5.0.0 has no note"]);
    expect(seen.prCalls).toBe(0);
    expect(seen.path).toEqual(["gate", "preflight", "held"]);
    expect(seen.cleanHeldBy).toEqual([]);
    expect(seen.prompt).toContain("Untriaged vendor updates: dependency bumps in the diff without a note. Return held_by with every missing item.");
  });

  it("[sma:k_ws_infra] the release ritual is not hardcoded: a plugin target runs the repo's push script, any other target runs the errand with the given deploy_steps; production asks the owner first and a refusal deploys nothing", async () => {
    const seen = await observeG.k_ws_infra();
    expect(seen.other.path).toEqual(["preflight", "tests", "run_deploy", "post_check", "record", "deployed_other"]);
    expect(seen.other.plugin).toBe(0);
    expect(seen.other.out).toEqual({ status: "deployed", deployed_version: "v2", post_check_ok: true, rollback_needed: false, log_path: "log" });
    expect(seen.plugin.path).toEqual(["preflight", "push_plugin", "post_check", "record", "deployed"]);
    expect(seen.plugin.errand).toBe(0);
    expect(seen.plugin.out).toMatchObject({ status: "deployed", deployed_version: "0.1.183" });
    expect(seen.prod.path).toEqual(["preflight", "tests", "approve", "run_deploy", "post_check", "record", "deployed_other"]);
    expect(seen.refused).toEqual({ path: ["preflight", "tests", "approve", "aborted"], status: "aborted", deploys: 0 });
    expect(seen.readsSteps).toBe(true);
    expect([seen.errandRole, seen.errandAuthorized]).toEqual(["errand", true]);
    expect(seen.inputs).toEqual(["target", "environment", "ref", "accounts", "deploy_steps", "health_url"]);
  });

  it("[sma:k_ws_push] the current branch is pushed once, by the errand that opens the PR, before the PR; a held ship (gate, preflight or review) never reaches it", async () => {
    const seen = await observeG.k_ws_push();
    expect(seen.shippedPr).toBe(1);
    expect(seen.shippedOut).toMatchObject({ status: "shipped", pr_url: "https://git.example/pr/7" });
    expect(seen.holds).toEqual([{ pr: 0, status: "held" }, { pr: 0, status: "held" }, { pr: 0, status: "held" }]);
    expect(seen.prompt).toMatch(/^Push the phase branch \(git push -u origin HEAD\), /);
    expect(seen.prompt).not.toContain("--force");
    expect(seen.pushBeforePr).toBe(true);
    expect(seen.role).toBe("errand");
  });

  it("[sma:k_ws_pr] the PR body comes from the phase's SUMMARY.md and BOOK.md through a temp file outside the repositories and is passed with --body-file; the run emits the PR url", async () => {
    const seen = await observeG.k_ws_pr();
    expect(seen.status).toBe("shipped");
    expect(seen.prUrl).toBe("https://git.example/pr/7");
    expect(seen.prompt).toContain("write the PR body from the phase's SUMMARY.md and BOOK.md (what, why, how it was verified, receipts) into a temp file made with mktemp outside every repository");
    expect(seen.prompt).toContain("open it with gh pr create --body-file <that file> and delete the file");
    expect(seen.consumes).toEqual([{ kind: "report", version: 1, from: "preflight" }]);
  });

  it("[sma:k_ws_review] the optional review runs only when asked, a rework or block verdict holds the ship before the PR, a pass goes on; the range is base..HEAD", async () => {
    const seen = await observeG.k_ws_review();
    expect(seen.off.path).toEqual(SHIPPED);
    expect(seen.off.skipped).toEqual(["review", "post_ship"]);
    expect(seen.off.reviewCalls).toBe(0);
    expect(seen.pass.path).toEqual(["gate", "preflight", "review", "open_pr", "hooks", "goal_check", "shipped"]);
    expect(seen.pass.reviewCalls).toBe(1);
    for (const verdict of [seen.rework, seen.block]) {
      expect(verdict.path).toEqual(["gate", "preflight", "review", "held_review"]);
      expect(verdict.out).toEqual({ status: "held", pr_url: "", held_by: ["external review asked for rework or blocked the ship"], hooks_failed: [] });
      expect(verdict.prCalls).toBe(0);
    }
    expect(seen.range).toEqual({ range: "main..HEAD" });
  });

  it("[sma:k_ws_track] the shipment is recorded by the errand that opens the PR: in .agents/deploys.log and as the phase's status and last activity in STATE.md", async () => {
    const seen = await observeG.k_ws_track();
    expect(seen.path).toEqual(SHIPPED);
    expect(seen.status).toBe("shipped");
    expect(seen.prompt).toContain("record the shipment in .agents/deploys.log and set the phase's status and last activity in .agents/planning/STATE.md.");
    // the record comes after the PR is opened
    expect(seen.prompt.indexOf("gh pr create")).toBeLessThan(seen.prompt.indexOf(".agents/deploys.log"));
    expect(seen.prompt.indexOf(".agents/deploys.log")).toBeLessThan(seen.prompt.indexOf("STATE.md"));
  });

  it("[sma:k_ws_post] post-ship hooks run only when hook files exist, once, and a failed hook is listed without holding the ship", async () => {
    const seen = await observeG.k_ws_post();
    expect(seen.none).toEqual({ path: SHIPPED, calls: 0, failed: [], status: "shipped" });
    expect(seen.some).toEqual({ path: ["gate", "preflight", "open_pr", "hooks", "post_ship", "goal_check", "shipped"], calls: 1, failed: ["h2"], status: "shipped" });
    expect(seen.renders).toBe(true);
    expect(seen.notUndone).toBe(true);
  });
});

describe("project start, new project, code analysis (n1344, n1345, n1347, n1348)", () => {
  it("[sma:k_c_start] the first run builds the value map before any question, then the preview, the profile writer, the owner's gaps, research, requirements and the recap; a started project resumes", async () => {
    const seen = await observeG.k_c_start();
    expect(seen.first).toEqual(["tree", "probe", "value_map", "preview", "profile_write", "ask", "research", "requirements", "recap", "done"]);
    expect(seen.valueMapBeforeAsk).toBe(true);
    expect(seen.out).toEqual({ status: "done", value_map: "v", next_steps: ["a", "b", "c"], refused: [] });
    expect(seen.valuePrompt).toMatch(/^Value map builder, before asking anything:/);
    expect(seen.resumed).toEqual({ path: ["tree", "probe", "resumed"], out: { status: "resumed", value_map: "", next_steps: ["the project is already started — continue with project-resume"], refused: [] } });
    // a profile alone is not a started project: the map and the roadmap are still missing
    expect(seen.profileOnly).toEqual(["tree", "probe", "value_map", "preview", "profile_write", "research", "requirements", "recap", "done"]);
    expect(seen.noRoadmap).toEqual(["tree", "probe", "preview", "profile_write", "research", "requirements", "recap", "done"]);
    expect(seen.profileWrites).toBe(1);
  });

  it("[sma:k_c_newproject] with the start research on the start researches and writes requirements in one flow, ending in the recap; quick mode has neither, and with the research off nothing but the map, the preview and the recap runs", async () => {
    const seen = await observeG.k_c_newproject();
    expect(seen.full).toEqual(["tree", "probe", "value_map", "preview", "profile_write", "ask", "research", "requirements", "recap", "done"]);
    expect(seen.recapOut).toEqual(["a", "b", "c"]);
    expect(seen.quick).toEqual(["tree", "probe", "value_map", "preview", "profile_write", "ask", "recap", "done"]);
    expect(seen.quickSkipped).toEqual(["research", "requirements"]);
    expect(seen.off).toEqual(["tree", "value_map", "preview", "recap", "done"]);
    expect(seen.offSkipped).toEqual(["probe", "profile_write", "ask", "research", "requirements"]);
    expect(seen.requirementsCalls).toEqual([1, 0, 0]);
    expect(seen.researchCalls).toEqual([1, 0, 0]);
  });

  it("[sma:k_c_mapcode] the code analysis runs one analysis (deep in full mode), writes its report to reports/analysis-<run>.md and ends done with the recommendation and the report path", async () => {
    const seen = await observeG.k_c_mapcode();
    expect(seen.full.path).toEqual(["analyze", "report", "done"]);
    expect(seen.full.analyze).toEqual({ goal: "how the merge queue works", scope: "src/server", depth: "deep" });
    expect(seen.std.analyze).toEqual({ goal: "how the merge queue works", scope: "src/server", depth: "standard" });
    expect(seen.full.out).toEqual({ status: "done", summary: "go", decisions: [], risks: [], recommendation: "go", confidence: 78, report_path: "reports/analysis-run.md" });
    expect(seen.full.reports).toBe(1);
    expect(seen.reportPath).toBe("reports/analysis-{{run_id}}.md");
  });

  it("[sma:k_c_scan] a light scan of one focus area is the quick mode: the scope given goes through and the depth is quick; the standard mode is deeper", async () => {
    const seen = await observeG.k_c_scan();
    expect(seen.quick.analyze).toEqual({ goal: "how the merge queue works", scope: "src/rooms/phase", depth: "quick" });
    expect(seen.std.analyze).toEqual({ goal: "how the merge queue works", scope: "src/rooms/phase", depth: "standard" });
    expect(seen.quick.path).toEqual(["analyze", "report", "done"]);
    expect(seen.quick.out).toMatchObject({ status: "done", report_path: "reports/analysis-run.md" });
  });
});
