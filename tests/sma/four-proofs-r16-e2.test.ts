// Region 16 (slash commands and workflows), batch e, second half: audit-fix, add-tests, the live check and the review pipeline (n1283 … n1297).
// Every test runs the real code of the node through tests/sma/r16-world-e2.ts (the same observations the scene scripts/lp_drill/scenes/sma_r16_e.py proves).
import { describe, expect, it } from "vitest";
import { observeE2 } from "./r16-world-e2";

const FINDING = { severity: "high", file: "src/a.ts", line: 12, evidence: "return value of save() ignored" };
const ROUNDS = "first_review plan_fix build_fix re_review plan_fix2 build_fix2 re_review";

describe("audit-fix, add-tests and the live check (n1283 … n1290)", () => {
  it("[sma:k_c_auditfix] /sma-audit-fix with no findings audits first, plans the fixes from the audit's findings, builds, re-reviews and ends done; a clean audit stops there; what stays open after two rounds is classified for the owner and ends partial", async () => {
    const seen = await observeE2.k_c_auditfix();
    expect(seen.audited).toEqual([`${ROUNDS} done`, [FINDING], "done"]);
    expect(seen.clean).toEqual(["first_review done", "done"]);
    expect(seen.stuck).toEqual([`${ROUNDS} classify ask partial`, "partial", [FINDING], 1]);
  });

  it("[sma:k_c_addtests] /sma-add-tests with gaps given writes the tests at once; with a phase and no gaps it derives them and the owner confirms (a timeout blocks); failing tests go to the fixer and are run again; a failed write blocks", async () => {
    const seen = await observeE2.k_c_addtests();
    expect(seen.given).toEqual(["baseline write_tests run inventory done", "done", 5]);
    expect(seen.derived).toEqual(["derive confirm baseline write_tests run inventory done", "done"]);
    expect(seen.timeout).toEqual(["derive confirm blocked", "blocked"]);
    expect(seen.fixing).toEqual(["baseline write_tests run inventory classify fix_tests run inventory classify done", "done"]);
    expect(seen.noWrite).toEqual(["baseline write_tests blocked", "blocked"]);
  });

  it("[sma:k_c_qa] /sma-qa runs the live check of the accepted task through lp.browser-qa: the arguments reach the check as given, its reply comes back untouched, and a red check leaves the run failed", async () => {
    const seen = await observeE2.k_c_qa();
    expect(seen.ok.answered).toEqual({ runId: "lprun_1", taskId: "task-1", state: "passed", link: "@thread:thr_qa", result: { verdict: "passed" } });
    expect(seen.ok.run).toEqual([{ workflow_id: "lp.browser-qa", status: "succeeded", reason: null }]);
    expect(seen.ok.args).toEqual({ threadId: "pm", projectId: "proj", runId: "lprun_1", taskId: "task-1", url: "http://127.0.0.1:5173/", cases: ["Open home"], envClass: "local", viewports: "375,768,1280", authorized: false });
    expect(seen.red.answered).toEqual({ runId: "lprun_1", taskId: "task-1", state: "failed", link: "@thread:thr_qa", result: { verdict: "failed" }, reason: "case 1 failed" });
    expect(seen.red.run).toEqual([{ workflow_id: "lp.browser-qa", status: "failed", reason: "step_failed:verdict" }]);
  });

  it("[sma:k_wqa_find] the app is found on the default dev ports: each port that answers with a web page is a target, a 404, a JSON answer and a closed port are not", async () => {
    const seen = await observeE2.k_wqa_find();
    expect(seen.defaults).toEqual([3000, 5173, 8080, 4200, 8000]);
    expect(seen.hostId).toBe(true);
    expect(seen.listed).toBe(true);
    expect(seen.boundSome).toBe(true);
    expect(seen.mineFound).toBe(true);
    expect(seen.scan).toHaveLength(2);
    expect(seen.scanFirst).toBe(true);
  });

  it("[sma:k_wqa_notrun] nothing answering at the address stops the check with an unreachable error; an address that answers passes, userinfo and other schemes are refused, a missing workspace is named", async () => {
    const seen = await observeE2.k_wqa_notrun();
    expect(seen.reachable).toEqual({ ok: true, url: "…", hostOk: true, workspaceKnown: true });
    expect(seen.unreachable).toEqual({ ok: false, error: "browser_qa_url_unreachable:connect ECONNREFUSED 127.0.0.1:<port>" });
    expect(seen.userinfo).toEqual({ ok: false, error: "browser_qa_url_must_be_http_without_userinfo" });
    expect(seen.scheme).toEqual({ ok: false, error: "browser_qa_url_must_be_http_without_userinfo" });
    expect(seen.workspace).toEqual({ ok: false, error: "browser_qa_workspace_unreachable" });
  });

  it("[sma:k_wqa_spawn] the live check is handed to the machine's runner with the address, slug, every case, the viewports and the model; the report path and model come back; production needs the owner's authorization and a bad address starts nothing", async () => {
    const seen = await observeE2.k_wqa_spawn();
    expect(seen.passed).toEqual({ runner: "browser-qa-codex", exit: 0, verdict: "passed", report: ".agents/qa/check-1/REPORT.md", model: "gpt-x", backend: "chrome-qa", reason: null,
      argv: ["--project-cwd", "--url", "http://127.0.0.1:5173/", "--slug", "check-1", "--env-class", "local", "--viewports", "375,768,1280", "--backend", "chrome-qa", "--case", "Home opens", "--case", "Menu shows three items", "--model", "gpt-x", "--reasoning-effort", "high"] });
    expect(seen.authorized).toEqual(["--project-cwd", "--url", "http://127.0.0.1:5173/", "--slug", "check-1", "--env-class", "local", "--viewports", "375", "--backend", "chrome-qa", "--case", "Home opens", "--authorized", "--model", "gpt-x", "--reasoning-effort", "high"]);
    expect(seen.none).toMatchObject({ verdict: "blocked", report: null, reason: "browser_qa_report_missing" });
    expect(seen.bad).toBe("browser_qa_url_must_be_http_without_userinfo");
    expect(seen.production).toBe("browser_qa_requires_explicit_authorization_for_target_or_side_effect");
  });

  it("[sma:k_wqa_result] the plaque reads passed only when every control passed; a failure or a non-zero exit is failed; a blocked or pending control, a sum that does not add up, no controls or no plaque is blocked", async () => {
    const seen = await observeE2.k_wqa_result();
    expect(seen.verdicts).toEqual({ all: "passed", failed: "failed", blocked: "blocked", pending: "blocked", sum: "blocked", zero: "blocked", exit: "failed" });
    expect(seen.noPlaque).toBe("blocked");
    expect(seen.failedRun).toEqual({ verdict: "failed", text: "Total / Passed / Failed / Blocked: 3 / 2 / 1 / 0", path: ".agents/qa/check-1/REPORT.md", artifacts: [".agents/qa/check-1/REPORT.md", ".agents/qa/check-1/codex-run.json"] });
    expect(seen.missing).toEqual({ verdict: "blocked", reason: "browser_qa_report_missing", text: null });
  });

  it("[sma:k_wqa_route] a failed check goes back to the builder, a blocked newest receipt does not; the family stops at the writer.qa_stop_after-th failure (two by default, never when off)", () => {
    const seen = observeE2.k_wqa_route();
    expect([seen.one, seen.blocked, seen.laterFailed, seen.laterBlocked, seen.byTime]).toEqual(["returnable", "not_returnable", "returnable", "not_returnable", "returnable"]);
    expect([seen.stopTwo, seen.oneOfTwo, seen.stopThree, seen.never]).toEqual(["stop", "returnable", "returnable", "returnable"]);
    expect(seen.defaults).toEqual([2, null, null, 4, 2]);
  });
});

describe("the review pipeline (n1291 … n1297)", () => {
  it("[sma:k_wr_gate] a code review switched off by the project's config, or by the quick quality mode, is skipped with its own reason and lets the work through", async () => {
    const seen = await observeE2.k_wr_gate();
    expect(seen.off).toEqual({ allowed: true, review: "not_required", state: "skipped", reason: "disabled_by_project_setting" });
    expect(seen.quick).toEqual({ allowed: true, review: "not_required", state: "skipped", reason: "quality_mode_quick" });
  });

  it("[sma:k_wr_scope] the files to review are the list that was given, else the range's files, else the commits'; lock files and vendored or built folders never count, and the count sizes the review", async () => {
    const seen = await observeE2.k_wr_scope();
    expect(seen.given).toEqual({ files: ["src/x.ts", "src/y.ts"], count: 2, level: "quick" });
    expect(seen.ranged).toEqual({ files: ["src/a.ts", "src/b.ts"], count: 2, level: "quick" });
    expect(seen.commits).toEqual({ files: ["src/c.ts"], count: 1, level: "quick" });
    expect(seen.nothing).toEqual({ files: [], count: 0, level: "quick" });
    expect(seen.many).toEqual([25, "deep"]);
    expect(seen.some).toEqual([4, "standard"]);
  });

  it("[sma:k_wr_empty] an empty scope stops the review at once: no pre-pass and no reviewer, a pass with no findings", async () => {
    const seen = await observeE2.k_wr_empty();
    expect(seen.empty).toEqual(["scope nothing", "pass", [], 0, 0]);
    expect(seen.some).toBe("scope prepass spec_check dims");
    expect(seen.someDims).toBe(1);
  });

  it("[sma:k_wr_prepass] the structural pre-pass runs before any model: a rework finding ends the review there with no reviewer, a clean pre-pass lets the spec check and the reviewers start", async () => {
    const seen = await observeE2.k_wr_prepass();
    expect(seen.rework).toEqual(["scope prepass aggregate result", "rework", 0, 0]);
    expect(seen.clean).toEqual(["scope prepass spec_check dims", 1, 1]);
  });

  it("[sma:k_wr_spawn] the reviewers start at the depth of the quality mode: two dimensions in quick, four in standard, seven in full", async () => {
    const seen = await observeE2.k_wr_spawn();
    expect(seen.quick).toEqual(["correctness", "security"]);
    expect(seen.standard).toEqual(["correctness", "security", "maintainability", "performance"]);
    expect(seen.full).toEqual(["correctness", "security", "performance", "architecture", "maintainability", "best_practices", "silent_failures"]);
  });

  it("[sma:k_wr_commit] a finished review wave is kept in the phase as REVIEW.md with a section per wave, committed with the wave in its message; a later pass over a wave replaces that wave's section only", async () => {
    const seen = await observeE2.k_wr_commit();
    expect(seen.first).toEqual(["# Review — phase ph_sma", "## Wave 1 — passed", "status pass; critical 0, high 0; reviewer <by>", "- no findings"]);
    expect(seen.second).toEqual([...seen.first!, "## Wave 2 — failed", "status rework; critical 1, high 2; reviewer <by>", "- src/a.ts:3 bad"]);
    expect(seen.replaced).toEqual(["# Review — phase ph_sma", "## Wave 2 — failed", "status rework; critical 1, high 2; reviewer <by>", "- src/a.ts:3 bad", "## Wave 1 — failed", "status rework; critical 0, high 1; reviewer <by>", "- src/b.ts late"]);
    expect(seen.written.map((w) => [w.path, w.message])).toEqual([[".agents/phases/ph_sma/REVIEW.md", "phase ph_sma: REVIEW.md wave 1"], [".agents/phases/ph_sma/REVIEW.md", "phase ph_sma: REVIEW.md wave 2"], [".agents/phases/ph_sma/REVIEW.md", "phase ph_sma: REVIEW.md wave 1"]]);
    expect(seen.waves).toEqual([[1, "passed"], [2, "failed"], [1, "failed"]]);
  });

  it("[sma:k_wr_fix] a review that asks for rework offers review-fix; review-fix given those findings plans the fixes from exactly them without reviewing first, and with none given it reviews first", async () => {
    const seen = await observeE2.k_wr_fix();
    expect(seen.offered).toEqual(["rework", "review-fix"]);
    expect(seen.fix).toEqual({ path: "plan_fix build_fix re_review done", skipped: ["first_review"], gaps: [FINDING], mode: "gaps", status: "done" });
    expect(seen.audit).toEqual({ path: `${ROUNDS} done`, reviewed: 1, gaps: [FINDING] });
  });
});
