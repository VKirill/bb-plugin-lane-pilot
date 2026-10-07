import { describe, expect, it } from "vitest";
import { runSim } from "./chain-harness";
import type { SimResult } from "./chain-harness";

/** The fragments (`lp.*`, `ins.post`): called by the chains as subworkflows, each run here on stubs. */
const pathOf = (result: SimResult) => result.path.join(" ");
const out = (result: SimResult) => result.summary.output;

describe("lp.analyze", () => {
  it("standard: gather, assess, done", async () => {
    const r = await runSim("lp.analyze", { input: { goal: "Add a --json flag" }, stubs: { assess: { confidence: 80, scope_verdict: "small" } } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("gather assess done");
    expect(out(r)).toMatchObject({ scope_verdict: "small", recommendation: "go", confidence: 80 });
  });

  it("low confidence goes back to gather in the same session until it rises (at most 3 rounds)", async () => {
    const r = await runSim("lp.analyze", { input: { goal: "g" }, stubs: { assess: [{ confidence: 40 }, { confidence: 55 }, { confidence: 75 }] } });
    expect(pathOf(r)).toBe("gather assess gather assess gather assess done");
    expect(r.calls.filter((call) => call.node === "assess")).toHaveLength(3);
    const via = r.db.prepare("SELECT input_json FROM lane_pilot_wf_step WHERE run_id=? AND step_key='gather#2'").get(r.summary.runId) as { input_json: string };
    expect(JSON.parse(via.input_json).via.mode).toBe("same-session");
  });

  it("a stalled analysis stops asking for more and says what it still does not know", async () => {
    const r = await runSim("lp.analyze", { input: { goal: "g" }, stubs: { assess: { confidence: 45, stalled: true, residual_risks: ["no tests in the area"] } } });
    expect(pathOf(r)).toBe("gather assess done");
    expect(out(r)).toMatchObject({ confidence: 45, residual_risks: ["no tests in the area"] });
  });

  it("quick depth never loops; full adds the independent second opinion", async () => {
    const quick = await runSim("lp.analyze", { input: { goal: "g", depth: "quick" }, mode: "quick", stubs: { assess: { confidence: 30 } } });
    expect(pathOf(quick)).toBe("gather assess done");
    const full = await runSim("lp.analyze", { input: { goal: "g", depth: "deep" }, mode: "full", stubs: { assess: { confidence: 90 } } });
    expect(pathOf(full)).toBe("gather assess second_opinion done");
  });
});

describe("lp.plan", () => {
  const task = (id: string) => ({ id, objective: id });
  it("quick: one task, linted, no plan critique", async () => {
    const r = await runSim("lp.plan", { input: { goal: "g" }, mode: "quick", stubs: { plan: { tasks: [task("t1")], task_count: 1, waves: [["t1"]] } } });
    expect(pathOf(r)).toBe("plan lint ok");
    expect(out(r)).toMatchObject({ status: "ok", task_count: 1, waves: [["t1"]] });
  });

  it("standard with 3 tasks: the whole plan is critiqued, a rework goes back to the planner in the same session", async () => {
    const r = await runSim("lp.plan", { input: { goal: "g" }, stubs: { plan: { tasks: [task("a"), task("b"), task("c")], task_count: 3 }, plan_critic: [{ status: "rework" }, { status: "pass" }] } });
    expect(pathOf(r)).toBe("plan lint plan_critic plan lint plan_critic ok");
    expect(out(r)).toMatchObject({ status: "ok", plan_verdict: "pass" });
    const second = r.db.prepare("SELECT input_json FROM lane_pilot_wf_step WHERE run_id=? AND step_key='plan#2'").get(r.summary.runId) as { input_json: string };
    expect(JSON.parse(second.input_json).via.mode).toBe("same-session");
  });

  it("standard with fewer than 3 tasks skips the critique", async () => {
    const r = await runSim("lp.plan", { input: { goal: "g" }, stubs: { plan: { tasks: [task("a")], task_count: 1 } } });
    expect(pathOf(r)).toBe("plan lint ok");
  });

  it("a contract that does not lint three times asks the owner; proceeding gives a low-confidence plan, aborting fails it", async () => {
    const stubs = { plan: { tasks: [task("a")], task_count: 1 }, lint: { ok: false, errors: ["owns_paths overlap"] } };
    const proceed = await runSim("lp.plan", { input: { goal: "g" }, stubs, humans: { ask: { answer_kind: "proceed" } } });
    expect(pathOf(proceed)).toBe("plan lint plan lint plan lint ask low");
    expect(out(proceed)).toMatchObject({ status: "low_confidence" });
    const abort = await runSim("lp.plan", { input: { goal: "g" }, stubs, humans: { ask: { answer_kind: "abort" } } });
    expect(pathOf(abort)).toBe("plan lint plan lint plan lint ask failed");
    expect(out(abort)).toMatchObject({ status: "failed" });
  });

  it("the critique that keeps asking for rework ends at the owner after 3 rounds", async () => {
    const r = await runSim("lp.plan", { input: { goal: "g" }, mode: "full", stubs: { plan: { tasks: [task("a")], task_count: 1 }, plan_critic: { status: "rework" } }, humans: { ask: { answer_kind: "proceed" } } });
    expect(pathOf(r)).toBe("plan lint plan_critic plan lint plan_critic plan lint plan_critic ask low");
  });
});

describe("lp.build", () => {
  const tasks = [{ id: "t1", depends_on: [] }, { id: "t2", depends_on: ["t1"] }, { id: "t3", depends_on: [] }];
  const accept = (ctx: { input: { item?: unknown } }) => ({ state: "accepted", merge_commit: `c-${(ctx.input.item as { id: string }).id}` });

  it("all accepted and the gate green: done, with the commits", async () => {
    const r = await runSim("lp.build", { input: { tasks }, stubs: { run_tasks: accept as never, gate: { ok: true } } });
    expect(pathOf(r)).toBe("run_tasks gate done");
    expect(out(r)).toMatchObject({ status: "done", accepted_ids: ["t1", "t2", "t3"], merged_commits: ["c-t1", "c-t2", "c-t3"], gate_ok: true });
    // t2 waits for t1: it starts after t1 has finished.
    const starts = r.db.prepare("SELECT node_id, scope, started_at, ended_at FROM lane_pilot_wf_step WHERE run_id=? AND node_id='run_tasks:child' ORDER BY scope").all(r.summary.runId) as Array<{ started_at: number; ended_at: number }>;
    expect(starts).toHaveLength(3);
    expect(r.called("run_tasks:child").map((call) => (call.input as { contract?: unknown }).contract ?? null)).toHaveLength(3);
  });

  it("one failed task: partial, with its findings for the replan", async () => {
    const stub = (ctx: { input: { item?: unknown } }) => ((ctx.input.item as { id: string }).id === "t3" ? { state: "failed", verdict: { status: "rework", findings: [{ file: "a.ts", severity: "high", evidence: "e" }] } } : accept(ctx));
    const r = await runSim("lp.build", { input: { tasks }, stubs: { run_tasks: stub as never } });
    expect(pathOf(r)).toBe("run_tasks gate partial");
    expect(out(r)).toMatchObject({ status: "partial", accepted_ids: ["t1", "t2"], failed_ids: ["t3"], failed_findings: [{ file: "a.ts", severity: "high", evidence: "e" }], merged_commits: ["c-t1", "c-t2"] });
  });

  it("a red integration gate keeps a fully accepted batch from being done", async () => {
    const r = await runSim("lp.build", { input: { tasks }, stubs: { run_tasks: accept as never, gate: { ok: false, failing: ["npm test"] } } });
    expect(pathOf(r)).toBe("run_tasks gate partial");
    expect(out(r)).toMatchObject({ status: "partial", gate_ok: false });
  });

  it("nothing accepted: blocked, without reading the gate", async () => {
    const r = await runSim("lp.build", { input: { tasks }, stubs: { run_tasks: { state: "blocked" } } });
    expect(pathOf(r)).toBe("run_tasks blocked");
    expect(out(r)).toMatchObject({ status: "blocked", blocked_ids: ["t1", "t2", "t3"], gate_ok: false });
  });
});

describe("lp.review", () => {
  const finding = (severity: string, dimension: string, extra: Record<string, unknown> = {}) => ({ file: "src/a.ts", line: 10, severity, dimension, evidence: "return a == b", impact: "wrong", suggestion: "use ===", ...extra });
  const dims = (rows: Record<string, unknown[]>) => ((ctx: { input: { item?: unknown } }) => ({ dimension: String(ctx.input.item), findings: rows[String(ctx.input.item)] ?? [] })) as never;

  it("quick: two dimensions, no spec check, no majority check, a clean pass", async () => {
    const r = await runSim("lp.review", { input: { range: "HEAD~1..HEAD", dimensions: ["correctness", "security"] }, mode: "quick" });
    expect(pathOf(r)).toBe("scope dims confirm aggregate result");
    expect(r.skipped).toContain("confirm");
    expect(out(r)).toMatchObject({ status: "pass", warn: false, critical_count: 0 });
    expect(r.called("dims:child")).toHaveLength(2);
  });

  it("standard: a critical finding is confirmed by 3 critics, 2 of 3 decide, and the work goes back", async () => {
    const r = await runSim("lp.review", { input: { dimensions: ["correctness", "maintainability"] }, stubs: { "dims:child": dims({ correctness: [finding("critical", "correctness")] }), confirm: { finding_id: "x", confirmed: true } } });
    expect(pathOf(r)).toBe("scope spec_check dims confirm aggregate result");
    expect(out(r)).toMatchObject({ status: "rework", critical_count: 1 });
    expect(r.called("confirm:child")).toHaveLength(3);
    const step = r.db.prepare("SELECT receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='confirm:child'").get(r.summary.runId) as { receipt_json: string };
    expect(JSON.parse(step.receipt_json).detail.asked).toBe(3);
  });

  it("a finding the majority rejects is dropped and the review passes", async () => {
    const r = await runSim("lp.review", { input: { dimensions: ["correctness"] }, stubs: { "dims:child": dims({ correctness: [finding("high", "correctness")] }), spec_check: { unmet_count: 0 }, confirm: { confirmed: false } } });
    expect(out(r)).toMatchObject({ status: "pass", high_count: 0, findings: [] });
  });

  it("no changed files: nothing to review", async () => {
    const r = await runSim("lp.review", { input: { dimensions: ["correctness"] }, stubs: { scope: { files: [], count: 0 } } });
    expect(pathOf(r)).toBe("scope nothing");
    expect(out(r)).toMatchObject({ status: "pass", remaining_actionable: 0 });
  });

  it("an unmet acceptance criterion sends the work back whatever the dimensions say", async () => {
    const r = await runSim("lp.review", { input: { dimensions: ["correctness"], criteria: ["flag exists"] }, stubs: { spec_check: { unmet_count: 1 } } });
    expect(out(r)).toMatchObject({ status: "rework" });
  });
});

describe("lp.close", () => {
  it("goals met: staged knowledge, project life, report, closed", async () => {
    const r = await runSim("lp.close", { input: { goal: "g", goals: [{ id: "g1" }, { id: "g2" }], merged_commits: ["c1"] }, stubs: { goal_audit: { all_met: true, intent_aligned: true }, memory: { staged: 2, candidate_ids: ["m1", "m2"] } } });
    expect(pathOf(r)).toBe("goal_audit memory life report closed");
    expect(out(r)).toMatchObject({ status: "closed", staged: 2, candidate_ids: ["m1", "m2"] });
  });

  it("unmet goals end the fragment as unmet with their ids, before anything is staged", async () => {
    const r = await runSim("lp.close", { input: { goals: [{ id: "g1" }, { id: "g2" }] }, stubs: { goal_audit: { all_met: false, unmet_ids: ["g2"] } } });
    expect(pathOf(r)).toBe("goal_audit unmet");
    expect(out(r)).toMatchObject({ status: "unmet", unmet_ids: ["g2"] });
  });

  it("intent drift asks the owner; proceeding continues, anything else halts", async () => {
    const stubs = { goal_audit: { intent_aligned: false, drift_items: ["scope grew"] } };
    const go = await runSim("lp.close", { input: { goals: [{ id: "g1" }, { id: "g2" }] }, stubs, humans: { reground_ask: { answer_kind: "proceed" } } });
    expect(pathOf(go)).toBe("goal_audit reground_ask memory life report closed");
    const halt = await runSim("lp.close", { input: { goals: [{ id: "g1" }, { id: "g2" }] }, stubs, humans: { reground_ask: { answer_kind: "halt" } } });
    expect(pathOf(halt)).toBe("goal_audit reground_ask halted");
    expect(out(halt)).toMatchObject({ status: "halted", intent_aligned: false });
  });

  it("quick mode with one goal skips the audit", async () => {
    const r = await runSim("lp.close", { input: { goals: [{ id: "g1" }] }, mode: "quick" });
    expect(r.skipped).toEqual(["goal_audit"]);
    expect(out(r)).toMatchObject({ status: "closed" });
  });
});

describe("lp.brainstorm", () => {
  const roles = ["product-manager", "system-architect", "ux-expert"];
  const role = (bad: string[] = []) => ((ctx: { input: { item?: unknown } }) => ({ role: String(ctx.input.item), digest: { decisions: [String(ctx.input.item)] }, ok: !bad.includes(String(ctx.input.item)) })) as never;

  it("roles work in parallel, a cross-role review finds conflicts, the owner resolves them, the guidance is written", async () => {
    const r = await runSim("lp.brainstorm", { input: { topic: "t", roles }, stubs: { designs: role(), cross_review: { conflict_count: 2, conflicts: [{}, {}] } }, humans: { resolve: { answer_kind: "resolved", resolutions: [{ role: "ux-expert" }] } } });
    expect(pathOf(r)).toBe("terms designs cross_review resolve guidance ok");
    expect(out(r)).toMatchObject({ status: "ok" });
    expect(r.called("designs:child")).toHaveLength(3);
  });

  it("no conflicts: the owner is not asked", async () => {
    const r = await runSim("lp.brainstorm", { input: { topic: "t", roles }, stubs: { designs: role(), cross_review: { conflict_count: 0 } } });
    expect(r.skipped).toEqual(["resolve"]);
  });

  it("a failed role is a low-confidence result; all roles failed is a failure", async () => {
    const low = await runSim("lp.brainstorm", { input: { topic: "t", roles }, stubs: { designs: role(["ux-expert"]), cross_review: { conflict_count: 0 } } });
    expect(pathOf(low)).toBe("terms designs cross_review resolve guidance low");
    expect(out(low)).toMatchObject({ status: "low_confidence" });
    const none = await runSim("lp.brainstorm", { input: { topic: "t", roles }, stubs: { designs: role(roles) } });
    expect(pathOf(none)).toBe("terms designs failed");
    expect(out(none)).toMatchObject({ status: "failed" });
  });

  it("a role whose run crashes arrives failed and the brainstorm goes on (all_or_low_confidence)", async () => {
    const crash = ((ctx: { input: { item?: unknown } }) => { if (ctx.input.item === "ux-expert") throw new Error("thread died"); return { role: String(ctx.input.item), digest: {}, ok: true }; }) as never;
    const r = await runSim("lp.brainstorm", { input: { topic: "t", roles }, stubs: { designs: crash, cross_review: { conflict_count: 0 } } });
    expect(r.summary.status).toBe("succeeded");
    expect(out(r)).toMatchObject({ status: "low_confidence" });
  });
});

describe("ins.post", () => {
  const input = { post_url: "https://example.com/p/1", topic: "design systems" };
  it("collect, init, three analysis passes, validate, digest", async () => {
    const r = await runSim("ins.post", { input, stubs: { collect: { comments: 40, status: "done" }, init: { ok: true, post_folder: "insights/p1" }, validate: { ok: true }, critic: { rejects_open: 0 }, digest: { summary_path: "insights/p1/summary.md" } } });
    expect(pathOf(r)).toBe("collect init lenses psychology critic renorm validate digest ok");
    expect(out(r)).toMatchObject({ status: "ok", post_folder: "insights/p1", summary_path: "insights/p1/summary.md" });
  });

  it("a post with fewer than 5 comments, or a blocked collection, is blocked before any analysis", async () => {
    expect(pathOf(await runSim("ins.post", { input, stubs: { collect: { comments: 3, status: "done" } } }))).toBe("collect blocked");
    expect(pathOf(await runSim("ins.post", { input, stubs: { collect: { comments: 40, status: "blocked" } } }))).toBe("collect blocked");
  });

  it("validation or open rejects send the lenses back once; after that the post is rework_failed", async () => {
    const r = await runSim("ins.post", { input, stubs: { collect: { comments: 40 }, init: { ok: true, post_folder: "f" }, validate: { ok: false }, critic: { rejects_open: 2 } } });
    expect(pathOf(r)).toBe("collect init lenses psychology critic renorm validate lenses psychology critic renorm validate failed");
    expect(out(r)).toMatchObject({ status: "rework_failed", rejects_open: 2 });
  });
});
