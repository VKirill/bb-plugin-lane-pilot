import { describe, expect, it } from "vitest";
import { finding, firstInput, out, pathOf, task } from "./chain-helpers";
import { runSim } from "./chain-harness";

/** The single-step chains (what Maestro runs as one command): analyze-code, plan-only, code-review, grill-plan, test-gen, security-audit, issue-discover, retrospective, ui-audit. */

describe("analyze-code", () => {
  it("the spec's case: lp.analyze, a report, done; the depth follows the quality mode", async () => {
    const r = await runSim("analyze-code", { input: { goal: "Explain how the merge queue orders merges", scope: "src/server" }, stubs: { "lp.analyze": { recommendation: "go", confidence: 78, risks: [{ risk: "lock leak" }] } } });
    expect(pathOf(r)).toBe("analyze report done");
    expect(out(r)).toMatchObject({ status: "done", confidence: 78, summary: "go", risks: [{ risk: "lock leak" }], report_path: "stub" });
    expect(firstInput(r, "analyze")).toMatchObject({ depth: "standard", scope: "src/server" });
    expect(firstInput(await runSim("analyze-code", { input: { goal: "g" }, mode: "full", stubs: { "lp.analyze": { confidence: 90 } } }), "analyze").depth).toBe("deep");
  });
});

describe("plan-only", () => {
  it("the spec's case: analyze, plan, the plan saved as a file, analyze-plan-execute offered", async () => {
    const r = await runSim("plan-only", { input: { goal: "Plan 2FA via TOTP", scope: "src/auth" }, stubs: { "lp.plan": { status: "ok", task_count: 4, plan_verdict: "pass", tasks: [task("a"), task("b"), task("c"), task("d")] }, save: { plan_path: "plans/draft-1.json" } } });
    expect(pathOf(r)).toBe("analyze plan save offer done");
    expect(out(r)).toMatchObject({ status: "ok", plan_path: "plans/draft-1.json", critic_status: "pass", proposed_workflow: "analyze-plan-execute" });
    expect((out(r)!.tasks as unknown[]).length).toBe(4);
    const offer = r.db.prepare("SELECT receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='offer'").get(r.summary.runId) as { receipt_json: string };
    expect(JSON.parse(offer.receipt_json).detail).toMatchObject({ proposed: "analyze-plan-execute", inputs: { goal: "Plan 2FA via TOTP", tasks: expect.any(Array) } });
  });

  it("a failed plan is not saved or offered", async () => {
    const r = await runSim("plan-only", { input: { goal: "g" }, stubs: { "lp.plan": { status: "failed" } } });
    expect(pathOf(r)).toBe("analyze plan failed");
    expect(out(r)).toMatchObject({ status: "failed" });
  });
});

describe("code-review", () => {
  it("the spec's case: a rework verdict is reported and review-fix is offered", async () => {
    const r = await runSim("code-review", { input: { range: "main..feature/search", quality_mode: "standard" }, stubs: { "lp.review": { status: "rework", findings: [finding("high", { file: "src/search.ts", line: 22, evidence: "await missing" })], high_count: 1 } } });
    expect(pathOf(r)).toBe("review report offer_fix done_offer");
    expect(out(r)).toMatchObject({ status: "rework", proposed_workflow: "review-fix", high_count: 1, findings: [expect.objectContaining({ file: "src/search.ts" })] });
    expect(firstInput(r, "review")).toMatchObject({ range: "main..feature/search", dimensions: ["correctness", "security", "maintainability", "performance"] });
  });

  it("a clean review is only reported", async () => {
    const r = await runSim("code-review", { input: { pr: "123" }, stubs: { "lp.review": { status: "pass", warn: false } } });
    expect(pathOf(r)).toBe("review report done");
    expect(out(r)).toMatchObject({ status: "pass" });
    expect(out(r)).not.toHaveProperty("proposed_workflow");
  });
});

describe("grill-plan", () => {
  const input = { goal: "Add Redis cache in front of the API", plan: "cache GET by URL for 60s", depth: "standard" };
  it("the spec's case: walk the branches, synthesize locked, open and deferred", async () => {
    const r = await runSim("grill-plan", { input, stubs: { walk: { branches_walked: 5, questions_without_anchor: 0 }, synth: { locked: ["GET only"], open: ["invalidation on write"], risk_register: [{ risk: "stale reads", severity: "high" }] } } });
    expect(pathOf(r)).toBe("walk synth done");
    expect(out(r)).toMatchObject({ status: "done", branches_walked: 5, locked: ["GET only"], open: ["invalidation on write"], risk_register: [{ risk: "stale reads", severity: "high" }] });
  });

  it("questions that cite no code anchor send the walk round once more in the same session", async () => {
    const r = await runSim("grill-plan", { input, stubs: { walk: [{ branches_walked: 3, questions_without_anchor: 2 }, { branches_walked: 5, questions_without_anchor: 0 }] } });
    expect(pathOf(r)).toBe("walk walk synth done");
    expect(out(r)).toMatchObject({ branches_walked: 5 });
  });
});

describe("test-gen", () => {
  const input = { scope: "src/discount.ts", gaps: [{ file: "src/discount.ts", layer: "L1", priority: "high" }] };
  it("the spec's case: tests written, run, a code defect found by the triager, done", async () => {
    const r = await runSim("test-gen", { input, stubs: { write_tests: { state: "accepted", tests_added: 5 }, run: { ok: false, failures: [{ id: "AF-1" }], pass_rate: 80 }, classify: { converged: true, test_defects: [], code_defects: [finding("high", { file: "src/discount.ts", line: 14 })] } } });
    expect(pathOf(r)).toBe("write_tests run classify done");
    expect(out(r)).toMatchObject({ status: "done", tests_added: 5, pass_rate: 80, code_defects: [expect.objectContaining({ line: 14 })] });
  });

  it("green tests end at once; no test framework blocks", async () => {
    expect(pathOf(await runSim("test-gen", { input, stubs: { write_tests: { state: "accepted" }, run: { ok: true } } }))).toBe("write_tests run done");
    expect(pathOf(await runSim("test-gen", { input, stubs: { write_tests: { state: "accepted" }, run: { ok: false, no_framework: true } } }))).toBe("write_tests run blocked");
    expect(pathOf(await runSim("test-gen", { input, stubs: { write_tests: { state: "failed" } } }))).toBe("write_tests blocked");
  });

  it("test defects are fixed and the tests run again, at most 3 classifications; then partial", async () => {
    const bad = { converged: false, test_defects: [{ id: "T1" }], test_defect_count: 1, code_defects: [] };
    const fixed = await runSim("test-gen", { input, stubs: { write_tests: { state: "accepted" }, run: [{ ok: false }, { ok: true }], classify: bad, fix_tests: { state: "accepted" } } });
    expect(pathOf(fixed)).toBe("write_tests run classify fix_tests run done");
    const stuck = await runSim("test-gen", { input, stubs: { write_tests: { state: "accepted" }, run: { ok: false }, classify: bad, fix_tests: { state: "accepted" } } });
    expect(pathOf(stuck)).toBe("write_tests run classify fix_tests run classify fix_tests run classify partial");
    expect(out(stuck)).toMatchObject({ status: "partial" });
  });
});

describe("security-audit", () => {
  const rows = (...found: unknown[][]) => { let at = -1; return (() => { at += 1; return { phase: "p", findings: found[at] ?? [], warnings: [] }; }) as never; };
  it("the spec's case: a quick tier scans two phases, a high finding is reported and review-fix offered", async () => {
    const r = await runSim("security-audit", { input: { scope: ".", tier: "quick" }, stubs: { recon: { found_entry_points: true }, "scan:child": rows([finding("high", { file: "src/auth.ts", line: 9, evidence: "token compared with ==" })], []), report: { severity_distribution: { high: 1 } } } });
    expect(pathOf(r)).toBe("recon scan report offer done_offer");
    expect(out(r)).toMatchObject({ status: "done", tier: "quick", proposed_workflow: "review-fix", severity_distribution: { high: 1 } });
    expect((out(r)!.findings as unknown[]).length).toBe(1);
    expect(r.called("scan:child")).toHaveLength(2);
  });

  it("the tier decides the phases: standard 4, deep 6; no findings means no offer", async () => {
    const standard = await runSim("security-audit", { input: { tier: "standard" }, stubs: { recon: { found_entry_points: true } } });
    expect(standard.called("scan:child")).toHaveLength(4);
    expect(pathOf(standard)).toBe("recon scan report done");
    const deep = await runSim("security-audit", { input: { tier: "deep" }, stubs: { recon: { found_entry_points: true } } });
    expect(deep.called("scan:child")).toHaveLength(6);
  });

  it("nothing to attack (no entry points found) is blocked before scanning", async () => {
    const r = await runSim("security-audit", { input: { scope: "docs" }, stubs: { recon: { found_entry_points: false } } });
    expect(pathOf(r)).toBe("recon blocked");
  });
});

describe("issue-discover", () => {
  const perspectives = ["security", "performance", "reliability", "maintainability"];
  it("the spec's case: perspectives scanned in parallel, duplicates merged by code, cards created (dry run)", async () => {
    const dup = (file: string, line: number, severity: string) => ({ file, line, severity, description: `problem in ${file}` });
    const per = ((ctx: { input: { item?: unknown } }) => ({ perspective: String(ctx.input.item), findings: ctx.input.item === "security" ? [dup("a.ts", 1, "high"), dup("b.ts", 2, "low")] : ctx.input.item === "reliability" ? [dup("a.ts", 1, "critical")] : [] })) as never;
    const r = await runSim("issue-discover", { input: { scope: "src/orders", perspectives, dry_run: true }, stubs: { "scan:child": per, create: { created_ids: [] } } });
    expect(pathOf(r)).toBe("scan dedupe create done");
    expect(out(r)).toMatchObject({ status: "done", found: 3, duplicates_merged: 1, created_ids: [] });
    const merged = r.db.prepare("SELECT output_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='dedupe'").get(r.summary.runId) as { output_json: string };
    expect(JSON.parse(merged.output_json).findings.map((f: { file: string; severity: string }) => [f.file, f.severity])).toEqual([["a.ts", "critical"], ["b.ts", "low"]]);
    expect(firstInput(r, "create")).toBeDefined();
  });

  it("the default is all 8 perspectives", async () => {
    const r = await runSim("issue-discover", { input: {}, stubs: { create: { created_ids: [] } } });
    expect(r.called("scan:child")).toHaveLength(8);
  });
});

describe("retrospective", () => {
  it("the spec's case: lenses, insights, knowledge candidates staged", async () => {
    const r = await runSim("retrospective", { input: { run_id: "r-sample" }, stubs: { retro: { insights: [{ id: "INS-1a2b3c4d" }, { id: "INS-5e6f7a8b" }], retro_path: "retro/r-sample.md" }, stage: { staged: 2 } } });
    expect(pathOf(r)).toBe("retro stage done");
    expect(out(r)).toMatchObject({ status: "done", insights: [{ id: "INS-1a2b3c4d" }, { id: "INS-5e6f7a8b" }], candidates_staged: 2, retro_path: "retro/r-sample.md" });
  });
});

describe("ui-audit", () => {
  const audit = { score_40: 30, score_20: 14, findings: [finding("medium", { file: "src/pricing.tsx", line: 55, evidence: "focus ring missing" })], report_path: "reports/ui.md" };
  it("the spec's case: the browser captures the states, the designer scores them", async () => {
    const r = await runSim("ui-audit", { input: { url: "http://localhost:4173/pricing" }, stubs: { capture: { status: "pass", screenshots: ["s375.png", "s1280.png"] }, audit } });
    expect(pathOf(r)).toBe("capture audit done");
    expect(out(r)).toMatchObject({ status: "done", score_40: 30, score_20: 14, screenshots: ["s375.png", "s1280.png"], report_path: "reports/ui.md" });
  });

  it("a page that cannot be captured is blocked without an audit", async () => {
    const r = await runSim("ui-audit", { input: { url: "http://localhost:1/" }, stubs: { capture: { status: "block" } } });
    expect(pathOf(r)).toBe("capture blocked");
  });
});
