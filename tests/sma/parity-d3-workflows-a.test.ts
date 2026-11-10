import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { out, pathOf } from "../workflow/chain-helpers";
import { runSim } from "../workflow/chain-harness";
import { quickRow } from "../../src/rooms/phase/stages";
import { autoDue, autoInputs, contextDoc } from "../../src/rooms/phase/server/auto-stages";
import { nightlyDocsPrompt } from "../../src/rooms/docs/docs";
import type { Phase } from "../../src/rooms/phase/logic";

const workflow = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "workflows", `${name}.json`), "utf8")) as Record<string, any>;
const nodes = (name: string) => (workflow(name).nodes ?? []) as Array<Record<string, any>>;
const node = (name: string, id: string) => nodes(name).find((row) => row.id === id)!;
const bundled = JSON.parse(readFileSync(join(process.cwd(), "src/rooms/contracts/bundled-agents.json"), "utf8")) as Record<string, { prompt: string }>;
const role = (id: string) => bundled[id]?.prompt ?? "";
const phase = (record: Record<string, unknown>, stage = "verification") =>
  ({ id: "ph_test1", title: "t", goal: "g", state: "active", stage, edition: 1, record } as unknown as Phase);

const WRITE_OK = { state: "accepted", merged_commits: ["c1"] };
const PLAN_OK = { status: "ok", clear: true, task_count: 1, risk: "low", already_met: false, objective: "fix", tasks: [{ id: "q1" }], task: { id: "q1" }, waves: [["q1"]] };

describe("parity d3 workflows a", () => {
  it("[sma:k_c_diagnose] a failed verdict starts a parallel diagnosis of its gaps", async () => {
    const failed = phase({ verification: { verdict: { state: "failed", detail: "check p1 red; check p2 red", inputSha: "sha1", at: 1 } } });
    expect(autoDue(failed)).toEqual({ kind: "diagnose" });
    const inputs = autoInputs(failed, { kind: "diagnose" }) as { mode: string; symptom: string[]; session: string };
    expect(inputs.mode).toBe("from_failures");
    expect(inputs.symptom.length).toBeGreaterThan(0);
    expect(inputs.session).toContain("verdict-");
    // With a diagnosis already stored for this verdict's inputSha the machine replans instead of diagnosing again.
    const diagnosed = phase({ verification: { verdict: { state: "failed", detail: "d", inputSha: "sha1", at: 1 }, diagnosis: { inputSha: "sha1", diagnoses: [], diagnosis: "cause", at: 2 } } });
    expect(autoDue(diagnosed)).toEqual({ kind: "replan" });
    const r = await runSim("debug", { input: { mode: "from_failures", symptom: ["check p1 red", "check p2 red"] },
      stubs: { diagnose: [{ status: "confirmed", root_cause: "c1", confidence: 80, fix_direction: "f" }, { status: "partial", root_cause: "c2", confidence: 40, fix_direction: "f2" }] } });
    expect(pathOf(r)).toBe("session ask_symptoms diagnose diagnosed");
    expect((out(r) as { diagnoses: unknown[] }).diagnoses.length).toBe(2);
  });

  it("[sma:k_wq_init] each quick flag adds its step: discuss, research, validate, full write", async () => {
    const wf = workflow("issue-quick");
    for (const flag of ["full", "validate", "discuss", "research"]) expect(wf.inputs[flag]?.default).toBe(false);
    const stubs = { plan: PLAN_OK, write: WRITE_OK, "write-full": WRITE_OK, "lp.review": { critical_count: 0, high_count: 0, findings: [] }, state: { ok: true, note: "", comment: "done" }, validate: { verdict: "ok", notes: "" }, research: { notes: "files a.ts" } };
    expect(pathOf(await runSim("issue-quick", { input: { title: "t", text: "x", validate: true }, stubs }))).toBe("class plan validate lint write review state closed");
    expect(pathOf(await runSim("issue-quick", { input: { title: "t", text: "x", full: true }, stubs }))).toBe("class plan validate lint write-full review state closed");
    expect(pathOf(await runSim("issue-quick", { input: { title: "t", text: "x", research: true }, stubs }))).toBe("class research plan lint write review state closed");
    expect(pathOf(await runSim("issue-quick", { input: { title: "t", text: "x", discuss: true }, stubs, humans: { discuss: { answer: "the label", answer_kind: "answered" } } }))).toBe("class discuss plan lint write review state closed");
  });

  it("[sma:k_wq_research] the research flag inserts the research step and the plan sees its notes", async () => {
    expect(node("issue-quick", "plan").prompt).toContain("research.notes");
    const stubs = { plan: PLAN_OK, write: WRITE_OK, research: { notes: "files a.ts" } };
    const withIt = await runSim("issue-quick", { input: { title: "t", text: "x", research: true }, stubs });
    expect(pathOf(withIt)).toContain("research");
    const without = await runSim("issue-quick", { input: { title: "t", text: "x" }, stubs });
    expect(pathOf(without)).not.toContain("research");
  });

  it("[sma:k_wq_review] a quick change is reviewed and the review is advice, never a block", async () => {
    const r = await runSim("issue-quick", { input: { title: "t", text: "x" },
      stubs: { plan: PLAN_OK, write: WRITE_OK, "lp.review": { critical_count: 0, high_count: 1, findings: [{ severity: "high", file: "a.ts:3" }] }, state: { ok: true, note: "", comment: "done" } } });
    expect(pathOf(r)).toBe("class plan lint write review state closed");
    const output = out(r) as { status: string; review_findings: unknown[] };
    expect(output.status).toBe("closed");
    expect(output.review_findings.length).toBe(1);
    expect(node("issue-quick", "review").join.policy).not.toBe("all");
  });

  it("[sma:k_wq_state] a finished quick task leaves one table row in STATE.md", async () => {
    const first = quickRow("---\nphase: \"a\"\nstage: \"x\"\n---\n# State\n", { date: "2026-11-10", task: "fix typo", commit: "abc123" });
    expect(first).toContain("## Quick Tasks Completed");
    expect(first).toContain("| 2026-11-10 | fix typo | abc123 |");
    const second = quickRow(first, { date: "2026-11-10", task: "fix icon", commit: "def456" });
    expect(second.match(/## Quick Tasks Completed/g)!.length).toBe(1);
    expect(second).toContain("| 2026-11-10 | fix icon | def456 |");
    expect(second).toContain('phase: "a"');
    expect(second).toContain("# State");
    expect(pathOf(await runSim("issue-quick", { input: { title: "t", text: "x" }, stubs: { plan: PLAN_OK, write: WRITE_OK, "lp.review": { critical_count: 0, high_count: 0, findings: [] }, state: { ok: true, note: "", comment: "done" } } }))).toContain("state closed");
  });

  it("[sma:k_pl_debug] an existing debug session file resumes the run, a new one starts open", async () => {
    const resumed = await runSim("debug", { input: { session: "csv-crash" }, stubs: { session: { found: true, path: ".agents/planning/debug/csv-crash.md" }, investigate: { status: "confirmed", confidence: 80, pressure_pass: true, contradictions: 0, affected_files: ["a.ts:1"], refuted: 0, root_cause: "c", fix_direction: "f" }, verify_cause: { confirmed: true } } });
    expect(pathOf(resumed)).toBe("session investigate verify_cause confirmed");
    expect(node("debug", "investigate").prompt).toContain(".agents/planning/debug/");
    const fresh = await runSim("debug", { input: { session: "new-one" }, stubs: { session: { found: false, path: ".agents/planning/debug/new-one.md" }, investigate: { status: "inconclusive", confidence: 10, refuted: 0, pressure_pass: true, contradictions: 0, affected_files: [], root_cause: "", fix_direction: "" } }, humans: { ask_symptoms: { answer: "s", answer_kind: "answered" } } });
    expect(pathOf(fresh)).toContain("ask_symptoms");
  });

  it("[sma:k_c_audituat] audit-uat aggregates open acceptance items of all phases into an audit file", async () => {
    expect(node("audit-uat", "audit").prompt).toContain("UAT-AUDIT.md");
    const r = await runSim("audit-uat", { input: {}, stubs: { audit: { open_count: 2, audit_path: ".agents/planning/UAT-AUDIT.md" }, goal_check: { ok: true, verdict: "pass", reason: "", details: {} } } });
    expect(pathOf(r)).toBe("audit goal_check done");
    expect((out(r) as { open_count: number }).open_count).toBe(2);
  });

  it("[sma:k_c_aiphase] four roles write AI-SPEC.md and a check gate stands before done", async () => {
    const clean = await runSim("ai-integration-phase", { input: { goal: "rank" },
      stubs: { select: { framework: "typesafe", options: [] }, research: { notes: "", quick_reference: "q", implementation_notes: "i", domain_notes: "d" }, eval_plan: { eval_plan: "e" }, spec: { spec_path: "x/AI-SPEC.md" }, check: { ok: true, gaps: [] } } });
    expect(pathOf(clean)).toBe("select research eval_plan spec check done");
    const rework = await runSim("ai-integration-phase", { input: { goal: "rank" },
      stubs: { select: { framework: "t", options: [] }, research: { notes: "" }, eval_plan: { eval_plan: "e" }, spec: { spec_path: "x" }, check: [{ ok: false, gaps: ["no eval"] }, { ok: true, gaps: [] }] } });
    expect(pathOf(rework)).toBe("select research eval_plan spec check spec check done");
    const blocked = await runSim("ai-integration-phase", { input: { goal: "rank" }, status: "succeeded",
      stubs: { select: { framework: "t", options: [] }, research: { notes: "" }, eval_plan: { eval_plan: "e" }, spec: { spec_path: "x" }, check: { ok: false, gaps: ["g"] } } });
    expect(pathOf(blocked)).toContain("blocked");
  });

  it("[sma:k_ag_airesearcher] the research outputs a quick reference and implementation guidance for AI-SPEC.md", () => {
    const research = node("ai-integration-phase", "research");
    expect(Object.keys(research.out)).toEqual(expect.arrayContaining(["quick_reference", "implementation_notes"]));
    const spec = node("ai-integration-phase", "spec").prompt;
    expect(spec).toContain("## Quick reference");
    expect(spec).toContain("## Implementation guidance");
    expect(role("ai-researcher")).toContain("quick reference");
    expect(role("ai-researcher")).toContain("implementation guidance");
  });

  it("[sma:k_ag_domain] expert criteria, failure modes and regulation precede the evaluation plan", () => {
    const r = role("domain-researcher");
    expect(r).toContain("expert criteria");
    expect(r).toContain("failure modes");
    expect(r).toContain("regulation");
    expect(Object.keys(node("ai-integration-phase", "research").out)).toContain("domain_notes");
    expect(node("ai-integration-phase", "eval_plan").prompt).toContain("domain_notes");
  });

  it("[sma:k_ag_evalplanner] the evaluation section holds dimensions, rubrics, guardrails and monitoring", () => {
    const spec = node("ai-integration-phase", "spec").prompt;
    for (const word of ["dimensions", "rubric", "guardrails", "monitoring"]) expect(spec).toContain(word);
    const r = role("eval-planner");
    for (const word of ["dimensions", "rubric", "guardrails", "monitoring"]) expect(r).toContain(word);
  });

  it("[sma:k_ag_evalauditor] each evaluation dimension is marked covered, partial or missing", () => {
    const prompt = node("eval-review", "review").prompt;
    expect(prompt).toContain("covered, partial or missing");
    expect(prompt).toContain("flawed");
    expect(role("eval-auditor")).toContain("covered, partial or missing");
  });

  it("[sma:k_wdi_gray] the owner chooses which gray areas get discussed", async () => {
    const stubs = { gather: { anchors: [], modules: [], conventions: [], summary: "s", stack: ["ts"], features: ["f"] },
      assess: { decisions: [], risks: [], scores_min: 1, scope_verdict: "small", recommendation: "go", confidence: 90, stalled: true, pressure_pass: true, open_questions: ["auth?", "cache?"], residual_risks: [], appetite: "s", no_gos: [], pitfalls: [] } };
    const r = await runSim("lp.analyze", { input: { goal: "g", ask_owner: true, owner_card: "card" }, stubs,
      humans: { choose: { chosen: ["auth?"], deferred: ["cache?"], answer_kind: "chosen" } } });
    expect(pathOf(r)).toContain("choose");
    expect((out(r) as { deferred_by_owner: string[] }).deferred_by_owner).toEqual(["cache?"]);
    const doc = contextDoc(phase({}), { open_questions: ["auth?", "cache?"], deferred_by_owner: ["cache?"], chosen: ["auth?"] });
    expect(doc.content).toContain("cache? — deferred by the owner");
  });

  it("[sma:k_wdi_advisor] with a developer profile an advisor compares each chosen area", async () => {
    const stubs = { gather: { anchors: [], modules: [], conventions: [], summary: "s", stack: [], features: [] },
      assess: { decisions: [], risks: [], scores_min: 1, scope_verdict: "small", recommendation: "go", confidence: 90, stalled: true, pressure_pass: true, open_questions: ["a?", "b?"], residual_risks: [], appetite: "s", no_gos: [], pitfalls: [] },
      advise: { area: "a?", options: [], pick: "one", advice: [{ option: "one" }] } };
    const advised = await runSim("lp.analyze", { input: { goal: "g", owner_card: "senior dev" }, stubs, humans: { choose: { chosen: ["a?", "b?"], deferred: [], answer_kind: "chosen" } } });
    expect(pathOf(advised)).toContain("advise");
    const skipped = await runSim("lp.analyze", { input: { goal: "g", owner_card: "" }, stubs });
    expect((out(skipped) as { advice: unknown[] }).advice).toEqual([]);
  });

  it("[sma:k_ag_projres] stack, features and pitfalls are researched before the roadmap", () => {
    expect(node("lp.analyze", "gather").prompt).toContain("stack");
    expect(node("lp.analyze", "gather").prompt).toContain("features");
    const done = node("lp.analyze", "done").map;
    expect(done.stack).toBe("gather.stack");
    expect(done.features).toBe("gather.features");
    expect(node("roadmap-driven", "roadmap").prompt).toContain("stack");
  });

  it("[sma:k_ag_docwriter] the docs pass takes the owner's assignment and runs for it", () => {
    const withA = nightlyDocsPrompt({ since: "yesterday", hasDocs: true, changed: [], assignment: "write a runbook for deploy" });
    expect(withA).toContain("owner_assignment");
    expect(withA).toContain("write a runbook for deploy");
    expect(withA).toContain("docs/");
    const without = nightlyDocsPrompt({ since: "yesterday", hasDocs: true, changed: [] });
    expect(without).not.toContain("owner_assignment");
    expect(workflow("lp.docs-night").inputs.assignment.default).toBe("");
    expect(workflow("lp.docs-maintenance").inputs.assignment.default).toBe("");
  });
});
