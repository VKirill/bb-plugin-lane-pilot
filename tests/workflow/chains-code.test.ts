import { describe, expect, it } from "vitest";
import { resolveRoleModel } from "@lane-pilot/models";
import { resolveTaskQualityMode } from "@lane-pilot/workflow-engine";
import { applyCodeCriticDefault } from "../../src/rooms/critique/quality-mode";
import { shortPathCriticDefault } from "../../src/rooms/workflow/server/workflow-executors";
import { finding, firstInput, modeOf, out, pathOf, task } from "./chain-helpers";
import { chainStore, runSim } from "./chain-harness";

/** Built-in chains that change code: full-lifecycle, refactor, review-fix, quality-loop, issue-full, issue-quick. */

describe("full-lifecycle", () => {
  const input = { goal: "Add an export button to the stats page", quality_mode: "full" };
  const base = () => ({ "lp.plan": { status: "ok", task_count: 2, has_ui: true, tasks: [task("t1"), task("t2")] }, "lp.build": { status: "done", merged_commits: ["c1", "c2"] }, replan: { status: "ok", tasks: [task("t3")] }, rebuild: { status: "done", merged_commits: ["c3"] } });

  it("the spec's case: a rework from the review goes back through replan and rebuild, then the browser, the owner and the close", async () => {
    const r = await runSim("full-lifecycle", { input, stubs: { ...base(), "lp.review": [{ status: "rework", findings: [finding("high")] }, { status: "pass" }], qa: { status: "pass" }, "lp.close": { status: "closed" } }, humans: { uat: { answer_kind: "ok" } } });
    expect(pathOf(r)).toBe("contract analyze plan build review replan rebuild review qa uat close done");
    expect(out(r)).toMatchObject({ status: "done", review_status: "pass", fix_rounds: 1, merged_commits: ["c1", "c2", "c3"] });
    expect(firstInput(r, "replan")).toMatchObject({ mode: "gaps", gaps: [expect.objectContaining({ severity: "high" })] });
    // The full set of review dimensions, and the review gets the commits the build merged.
    expect(firstInput(r, "review").dimensions).toEqual(["correctness", "security", "performance", "architecture", "maintainability", "best_practices"]);
    expect(firstInput(r, "review").range).toEqual(["c1", "c2"]);
  });

  it("quick is raised to standard: the review is mandatory and the owner's acceptance is skipped without full", async () => {
    const r = await runSim("full-lifecycle", { input: { goal: "g", quality_mode: "quick" }, stubs: { ...base(), "lp.review": { status: "pass" }, qa: { status: "pass" }, "lp.close": { status: "closed" } } });
    expect(modeOf(r)).toBe("standard");
    expect(firstInput(r, "review").dimensions).toEqual(["correctness", "security", "maintainability", "performance"]);
    expect(pathOf(r)).toBe("contract analyze plan build review qa uat close done");
    expect(r.skipped).toEqual(expect.arrayContaining(["uat"]));
  });

  it("two rework rounds end at the owner, who can accept what is merged", async () => {
    const r = await runSim("full-lifecycle", { input, stubs: { ...base(), "lp.review": { status: "rework", findings: [finding("critical")] }, "lp.close": { status: "closed" } }, humans: { escalate: { answer_kind: "accept" } } });
    expect(pathOf(r)).toBe("contract analyze plan build review replan rebuild review replan rebuild review escalate close done");
  });

  it("the owner's acceptance can send the work back with issues, once", async () => {
    const r = await runSim("full-lifecycle", { input, stubs: { ...base(), "lp.review": { status: "pass" }, qa: { status: "pass" }, "lp.close": { status: "closed" } }, humans: { uat: [{ answer_kind: "issues", issues: [finding("high")] }, { answer_kind: "ok" }] } });
    expect(pathOf(r)).toBe("contract analyze plan build review qa uat replan rebuild review qa uat close done");
  });

  it("a plan that fails or a build that merged nothing is blocked", async () => {
    expect(pathOf(await runSim("full-lifecycle", { input, stubs: { ...base(), "lp.plan": { status: "failed" } } }))).toBe("contract analyze plan blocked");
    expect(pathOf(await runSim("full-lifecycle", { input, stubs: { ...base(), "lp.build": { status: "blocked", merged_commits: [] } } }))).toBe("contract analyze plan build blocked");
  });

  it("a saved plan skips analysis and planning", async () => {
    const r = await runSim("full-lifecycle", { input: { goal: "g", tasks: [task("t1")], quality_mode: "standard" }, stubs: { "lp.build": { status: "done", merged_commits: ["c1"] }, "lp.review": { status: "pass" }, "lp.close": { status: "closed" } } });
    expect(r.skipped).toEqual(expect.arrayContaining(["analyze", "plan"]));
    expect(firstInput(r, "build").tasks).toEqual([task("t1")]);
  });
});

describe("refactor", () => {
  const input = { goal: "Split utils.ts into date.ts and string.ts, behavior unchanged", scope: "src/utils.ts" };
  const green = { baseline: { ok: true, tests_passed: 120, tests_failed: 0, no_tests: false }, equivalence: { ok: true, tests_passed: 120, tests_failed: 0 } };
  const stubs = () => ({ ...green, "lp.plan": { status: "ok", task_count: 2, tasks: [task("r1"), task("r2")] }, "lp.build": { status: "done", merged_commits: ["r1", "r2"] }, "lp.review": { status: "pass" } });

  it("the spec's case: baseline, analyze, plan, build, equivalence, review, done", async () => {
    const r = await runSim("refactor", { input, stubs: stubs() });
    expect(pathOf(r)).toBe("baseline analyze plan build equivalence review done");
    expect(out(r)).toMatchObject({ status: "done", equivalent: true, metrics_before: { tests_passed: 120 }, metrics_after: { tests_passed: 120 } });
    // The planning rules that keep behavior fixed ride with the plan request.
    expect((firstInput(r, "plan").extra_rules as string[]).join(" ")).toContain("all tests that passed in the baseline still pass");
    expect(firstInput(r, "review").dimensions).toEqual(["correctness", "maintainability", "architecture", "silent_failures"]);
  });

  it("no tests: the owner chooses characterization tests first, going on at risk, or stopping", async () => {
    const withNone = () => ({ ...stubs(), baseline: { ok: true, no_tests: true, tests_failed: 0 }, "test-gen": { status: "done" } });
    const first = await runSim("refactor", { input, stubs: withNone(), humans: { ask_no_tests: { answer_kind: "tests_first" } } });
    expect(pathOf(first)).toBe("baseline ask_no_tests tests_first analyze plan build equivalence review done");
    expect(String(firstInput(first, "tests_first").goal)).toContain("characterization tests");
    expect(pathOf(await runSim("refactor", { input, stubs: withNone(), humans: { ask_no_tests: { answer_kind: "proceed" } } }))).toBe("baseline ask_no_tests analyze plan build equivalence review done");
    const stop = await runSim("refactor", { input, stubs: withNone(), humans: { ask_no_tests: { answer_kind: "abort" } } });
    expect(pathOf(stop)).toBe("baseline ask_no_tests blocked");
    expect(out(stop)).toMatchObject({ status: "blocked", equivalent: false });
  });

  it("tests that fail after the build send it back once; a second failure is partial", async () => {
    const red = { ok: false, tests_passed: 100, tests_failed: 20 };
    const once = await runSim("refactor", { input, stubs: { ...stubs(), equivalence: [red, { ok: true, tests_passed: 120, tests_failed: 0 }], replan: { status: "ok", tasks: [task("fix")] }, rebuild: { status: "done", merged_commits: ["r3"] } } });
    expect(pathOf(once)).toBe("baseline analyze plan build equivalence replan rebuild equivalence review done");
    expect(firstInput(once, "replan").gaps).toEqual([expect.objectContaining({ tests_failed: 20 })]);
    const twice = await runSim("refactor", { input, stubs: { ...stubs(), equivalence: red, replan: { status: "ok" }, rebuild: { status: "done", merged_commits: ["r3"] } } });
    expect(pathOf(twice)).toBe("baseline analyze plan build equivalence replan rebuild equivalence partial");
    expect(out(twice)).toMatchObject({ status: "partial", equivalent: false });
  });

  it("a review rework goes back once; quick is raised to standard", async () => {
    const r = await runSim("refactor", { input: { ...input, quality_mode: "quick" }, stubs: { ...stubs(), "lp.review": [{ status: "rework", findings: [finding("high")] }, { status: "pass" }], replan: { status: "ok" }, rebuild: { status: "done", merged_commits: ["r3"] } } });
    expect(pathOf(r)).toBe("baseline analyze plan build equivalence review replan rebuild equivalence review done");
    expect(modeOf(r)).toBe("standard");
  });
});

describe("review-fix", () => {
  const spec = { goal: "Fix review findings", findings: [finding("high")] };
  const stubs = () => ({ "lp.plan": { status: "ok", task_count: 1, tasks: [task("f1")] }, "lp.build": { status: "done", merged_commits: ["f1"] } });

  it("the spec's case: given findings skip the first review, fix, review again, done", async () => {
    const r = await runSim("review-fix", { input: spec, stubs: { ...stubs(), "lp.review": { status: "pass", remaining_actionable: 0 } } });
    expect(pathOf(r)).toBe("first_review plan_fix build_fix re_review done");
    expect(r.skipped).toEqual(["first_review"]);
    expect(out(r)).toMatchObject({ status: "done", review_status: "pass", fix_rounds: 1, merged_commits: ["f1"] });
    expect(firstInput(r, "plan_fix")).toMatchObject({ mode: "gaps", gaps: spec.findings });
  });

  it("without findings the first review runs on the range and a clean one ends at once", async () => {
    const clean = await runSim("review-fix", { input: { goal: "g", range: "main..HEAD" }, stubs: { "lp.review": { status: "pass" } } });
    expect(pathOf(clean)).toBe("first_review done");
    const dirty = await runSim("review-fix", { input: { goal: "g", range: "main..HEAD" }, stubs: { ...stubs(), first_review: { status: "rework", findings: [finding("high")] }, re_review: { status: "pass", remaining_actionable: 0 } } });
    expect(pathOf(dirty)).toBe("first_review plan_fix build_fix re_review done");
    expect(firstInput(dirty, "first_review")).toMatchObject({ range: "main..HEAD" });
  });

  it("a re-review that still finds problems goes round once more, then the owner decides what remains", async () => {
    const r = await runSim("review-fix", { input: spec, stubs: { ...stubs(), "lp.review": { status: "rework", findings: [finding("critical")] }, plan_fix2: { status: "ok", tasks: [task("f2")] }, classify: { remaining: [finding("critical")] } }, humans: { ask: { answer_kind: "accept" } } });
    expect(pathOf(r)).toBe("first_review plan_fix build_fix re_review plan_fix2 build_fix re_review classify ask partial");
    expect(out(r)).toMatchObject({ status: "partial", remaining: [expect.objectContaining({ severity: "critical" })] });
  });

  it("a failed fix plan is blocked with the findings left", async () => {
    const r = await runSim("review-fix", { input: spec, stubs: { ...stubs(), "lp.plan": { status: "failed" } } });
    expect(pathOf(r)).toBe("first_review plan_fix blocked");
    expect(out(r)).toMatchObject({ status: "blocked", remaining: spec.findings });
  });
});


describe("quality-loop", () => {
  const input = { scope: "src/orders", quality_mode: "standard" };
  const rework = { status: "rework", findings: [finding("high", { file: "src/orders/total.ts", line: 31 })] };

  it("the spec's case: review, tests, classification, diagnosis, fix, and a second round that ends clean", async () => {
    const r = await runSim("quality-loop", { input, stubs: {
      review: [rework, { status: "pass" }], coverage: { gap_count: 2, framework_found: true }, "test-gen": { status: "done", tests_added: 2 },
      classify: [{ code_defect_count: 1, failures: [{ class: "code_defect" }], code_defects: [finding("high")] }, { code_defect_count: 0 }],
      debug: { status: "confirmed", fix_directions: ["use integer cents"] }, replan: { status: "ok", tasks: [task("q1")] }, "lp.build": { status: "done", merged_commits: ["q1"] }, qa: { status: "pass" },
    } });
    expect(pathOf(r)).toBe("review coverage test_gen classify diagnose replan build qa review coverage test_gen classify done");
    expect(out(r)).toMatchObject({ status: "done", rounds: 1 });
    // The review looks at the files of the scope, as a list.
    expect(firstInput(r, "review")).toMatchObject({ files: ["src/orders"], dimensions: ["correctness", "security", "maintainability", "silent_failures"] });
    expect(r.called("test_gen")).toHaveLength(2);
  });

  it("a clean first review with nothing to repair ends in one round; no test framework skips the test generation", async () => {
    const r = await runSim("quality-loop", { input, stubs: { review: { status: "pass" }, coverage: { gap_count: 3, framework_found: false }, classify: { code_defect_count: 0 } } });
    expect(pathOf(r)).toBe("review coverage test_gen classify done");
    expect(r.skipped).toEqual(["test_gen"]);
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("a failed fix plan or build asks the owner and ends partial with what remains", async () => {
    const r = await runSim("quality-loop", { input, stubs: { review: rework, coverage: { gap_count: 0 }, classify: { code_defect_count: 0 }, replan: { status: "failed" } }, humans: { ask: { answer_kind: "abort" } } });
    expect(pathOf(r)).toBe("review coverage test_gen classify replan ask partial");
    expect(out(r)).toMatchObject({ status: "partial", remaining: [expect.objectContaining({ severity: "high" })] });
  });

  it("quick is raised to standard; full adds the browser check for UI", async () => {
    const quick = await runSim("quality-loop", { input: { scope: "s", quality_mode: "quick" }, stubs: { review: { status: "pass" }, classify: { code_defect_count: 0 } } });
    expect(modeOf(quick)).toBe("standard");
    const full = await runSim("quality-loop", { input: { scope: "s", quality_mode: "full" }, stubs: { review: [rework, { status: "pass" }], classify: { code_defect_count: 0 }, replan: { status: "ok", has_ui: true, tasks: [task("q1")] }, "lp.build": { status: "done" }, qa: { status: "pass" } } });
    expect(pathOf(full)).toBe("review coverage test_gen classify replan build qa review coverage test_gen classify done");
    expect(full.skipped).not.toContain("qa");
  });
});

describe("issue-full", () => {
  const input = { title: "Wrong cart total", text: "total is off by one cent", context: "src/cart.ts" };
  const stubs = () => ({ triage: { clear: true, severity: "high" }, "lp.plan": { status: "ok", tasks: [task("i1")] }, "lp.build": { status: "done", merged_commits: ["i1"] }, "lp.review": { status: "pass" } });

  it("the spec's case: triage, root cause, plan, build, review, memory, closed - the results are the run's output", async () => {
    const r = await runSim("issue-full", { input, stubs: stubs() });
    expect(pathOf(r)).toBe("triage root_cause plan build review memory closed");
    expect(out(r)).toMatchObject({ status: "closed", resolution: "fixed", severity: "high", review_status: "pass", merged_commits: ["i1"] });
    expect(firstInput(r, "plan")).toMatchObject({ goal: "Wrong cart total", mode: "gaps" });
    // The issue reaches the root cause step as its inputs: no tracker card in between.
    expect(firstInput(r, "root_cause")).toMatchObject({ title: "Wrong cart total", text: "total is off by one cent", context: "src/cart.ts" });
  });

  it("an issue too vague to act on is blocked before any work; no tracker action exists in the chain", async () => {
    const r = await runSim("issue-full", { input: { title: "it broke", text: "?" }, stubs: { triage: { clear: false } } });
    expect(pathOf(r)).toBe("triage not_clear");
    expect(out(r)).toMatchObject({ status: "blocked", resolution: "open" });
    const store = await chainStore();
    for (const id of ["issue-full", "issue-quick", "issue-discover"]) {
      const text = JSON.stringify(store.get(id)!.workflow);
      expect(text).not.toContain("bb.tasks");
      expect(store.get(id)!.workflow.requires?.plugins ?? []).not.toContain("tasks");
    }
  });

  it("a review rework replans once; a second failure reports the issue open", async () => {
    const once = await runSim("issue-full", { input, stubs: { ...stubs(), "lp.review": [{ status: "rework", findings: [finding("high")] }, { status: "pass" }], replan: { status: "ok", tasks: [task("i2")] } } });
    expect(pathOf(once)).toBe("triage root_cause plan build review replan build review memory closed");
    const twice = await runSim("issue-full", { input, stubs: { ...stubs(), "lp.review": { status: "rework", findings: [finding("high")] }, replan: { status: "ok", tasks: [task("i2")] } } });
    expect(pathOf(twice)).toBe("triage root_cause plan build review replan build review partial");
    expect(out(twice)).toMatchObject({ status: "partial", resolution: "open", review_status: "rework" });
  });
});

describe("issue-batch", () => {
  const input = { title: "Three small fixes", text: "Typo in the Send button; the header icon color; the login hint." };
  it("one task per fix, built together, closed; an already-done batch closes without a build; a red build is partial", async () => {
    const tasks = [task("b1"), task("b2"), task("b3")];
    const ok = await runSim("issue-batch", { input, stubs: { "lp.plan": { status: "ok", task_count: 3, tasks, waves: [["b1", "b2", "b3"]] }, "lp.build": { status: "done", merged_commits: ["b1", "b2", "b3"] } } });
    expect(pathOf(ok)).toBe("plan build closed");
    expect(out(ok)).toMatchObject({ status: "closed", resolution: "fixed" });
    const already = await runSim("issue-batch", { input, stubs: { "lp.plan": { status: "ok", task_count: 0, tasks: [], already_met: true } } });
    expect(pathOf(already)).toBe("plan already");
    const red = await runSim("issue-batch", { input, stubs: { "lp.plan": { status: "ok", task_count: 3, tasks }, "lp.build": { status: "partial" } } });
    expect(pathOf(red)).toBe("plan build partial");
  });
  it("tells the planner to group edits of one component or sharing a slow check, and to split a failure list by cause (not one task per tiny edit)", async () => {
    const r = await runSim("issue-batch", { input, stubs: { "lp.plan": { status: "ok", task_count: 0, tasks: [], already_met: true } } });
    const constraints = JSON.stringify(firstInput(r, "plan"));
    expect(constraints).toMatch(/group the edits of one component, page or file/);
    expect(constraints).toMatch(/share one slow check/);
    expect(constraints).toMatch(/separate tasks only for edits in independent areas/);
    expect(constraints).toMatch(/verifiable cause, not by the number of red lines/);
    expect(constraints).not.toMatch(/one task per independent fix/);
  });
});

describe("issue-quick", () => {
  const input = { title: "Typo in button label", text: "The Send button says 'Sned'." };
  const one = { ...task("q1"), acceptance: ["npx vitest run tests/button.test.ts"] };
  const plan = { status: "ok", clear: true, task_count: 1, risk: "low", already_met: false, objective: "Fix the Send button label", tasks: [one], task: one, waves: [["q1"]] };
  const stubs = () => ({ plan, write: { state: "accepted", merged_commits: ["q1"] } });
  const modelSteps = (path: string, workflow: { nodes: Array<{ id: string; type: string }> }) => {
    const model = new Set(workflow.nodes.filter((node) => node.type === "agent" || node.type === "lp-task").map((node) => node.id));
    return path.split(" ").filter((id) => model.has(id));
  };

  it("a tiny low issue is class, one cheap plan, lint, the writer, closed, in at most three model calls", async () => {
    const r = await runSim("issue-quick", { input, stubs: stubs() });
    expect(pathOf(r)).toBe("class plan lint write closed");
    expect(modelSteps(pathOf(r), r.workflow).length).toBeLessThanOrEqual(3);
    expect(out(r)).toMatchObject({ status: "closed", resolution: "fixed", severity: "low", merged_commits: ["q1"] });
    expect(modeOf(r)).toBe("quick");
    const planNode = r.workflow.nodes.find((node) => node.id === "plan");
    expect(planNode).toMatchObject({ type: "agent", role: "triager" });
    expect(resolveRoleModel("triager", {}).model).not.toMatch(/opus/i);
    expect(r.summary.status).toBe("succeeded");
  });

  it("«покрась кнопку в синий» is class, plan, lint, write, then closed by the checks, in two model steps", async () => {
    const r = await runSim("issue-quick", { input: { title: "покрась кнопку в синий", text: "Кнопка отправки серая, должна быть синей." }, stubs: stubs() });
    expect(pathOf(r)).toBe("class plan lint write closed");
    expect(modelSteps(pathOf(r), r.workflow)).toEqual(["plan", "write"]);
    expect(r.summary.status).toBe("succeeded");
    const audit = r.db.prepare("SELECT detail FROM lane_pilot_wf_event WHERE run_id=? AND kind='goal_audit'").get(r.summary.runId) as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ by: "code", verdict: "pass" });
  });

  it("a goal the plan finds already met closes without a writer", async () => {
    const r = await runSim("issue-quick", { input, stubs: { plan: { ...plan, task_count: 0, tasks: [], already_met: true } } });
    expect(pathOf(r)).toBe("class plan already");
    expect(out(r)).toMatchObject({ status: "closed", resolution: "fixed" });
    expect(r.summary.status).toBe("succeeded");
  });

  it("medium risk writes with the code critic; low does not", async () => {
    const r = await runSim("issue-quick", { input, stubs: { plan: { ...plan, risk: "medium" }, "write-medium": { state: "accepted", merged_commits: ["q1"] } } });
    expect(pathOf(r)).toBe("class plan lint write-medium closed");
    expect(pathOf(r)).not.toContain(" write ");
    const node = r.workflow.nodes.find((item) => item.id === "write-medium");
    expect(node).toMatchObject({ type: "lp-task", quality_mode: "standard" });
    expect(shortPathCriticDefault("issue-quick", "standard")).toBe("medium");
    expect(shortPathCriticDefault("issue-quick", "quick")).toBeUndefined();
    expect(applyCodeCriticDefault({}, "standard", "medium", "medium")["code_critique.enabled"]).toBe(true);
    expect(applyCodeCriticDefault({}, "quick", "medium", "medium")["code_critique.enabled"]).toBeUndefined();
  });

  it("a critical issue, a large issue and a plan of many tasks are proposed to issue-full and do not write", async () => {
    const critical = await runSim("issue-quick", { input: { ...input, context: "app.tsx", severity: "critical" } });
    expect(pathOf(critical)).toBe("class escalate proposed");
    expect(out(critical)).toMatchObject({ status: "proposed", proposed_workflow: "issue-full", severity: "critical" });
    const step = critical.db.prepare("SELECT receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='escalate'").get(critical.summary.runId) as { receipt_json: string };
    const proposal = (JSON.parse(step.receipt_json) as { detail?: { inputs?: Record<string, unknown> } }).detail;
    expect(proposal?.inputs).toMatchObject({ title: "Typo in button label", text: "The Send button says 'Sned'.", context: "app.tsx", severity: "critical" });
    const large = await runSim("issue-quick", { input: { title: "Rewrite the architecture of the settings page", text: "Split settings into modules." } });
    expect(pathOf(large)).toBe("class escalate proposed");
    const many = await runSim("issue-quick", { input, stubs: { plan: { ...plan, task_count: 2, tasks: [task("q1"), task("q2")] } } });
    expect(pathOf(many)).toBe("class plan escalate proposed");
    expect(pathOf(many)).not.toMatch(/write/);
  });

  it("the mode stays quick and a full contract still conflicts; a vague issue is blocked; a failed write stays open", async () => {
    const asked = await runSim("issue-quick", { input, mode: "full", stubs: stubs() });
    expect(modeOf(asked)).toBe("quick");
    expect(resolveTaskQualityMode({ contract: "full", node: "quick", asked: "quick", workflow: asked.workflow.quality_mode }).ok).toBe(false);
    expect(pathOf(await runSim("issue-quick", { input, stubs: { plan: { ...plan, clear: false, task_count: 0, tasks: [] } } }))).toBe("class plan blocked");
    const r = await runSim("issue-quick", { input, stubs: { plan, write: { state: "blocked", merged_commits: [] } } });
    expect(pathOf(r)).toBe("class plan lint write partial");
    expect(out(r)).toMatchObject({ status: "partial", resolution: "open" });
  });
});
