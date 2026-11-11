import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerPureActions, registerReducers, WorkflowEngine, parseWorkflow } from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import type { Services } from "../../server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { out, pathOf } from "../workflow/chain-helpers";
import { runSim } from "../workflow/chain-harness";
import { quickRow } from "../../src/rooms/phase/stages";
import { debugSessionDoc, debugSessionSlug, quickStateEdit } from "../../src/rooms/workflow/server/workflow-executors";
import { AUTO_REPLANS, autoDue, autoInputs, contextDoc, createAutoStages } from "../../src/rooms/phase/server/auto-stages";
import { docsMaintenancePrompt, nightlyDocsPrompt } from "../../src/rooms/docs/docs";
import type { Phase } from "../../src/rooms/phase/logic";

const workflow = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "workflows", `${name}.json`), "utf8")) as Record<string, any>;
const nodes = (name: string) => (workflow(name).nodes ?? []) as Array<Record<string, any>>;
const node = (name: string, id: string) => nodes(name).find((row) => row.id === id)!;
const bundled = JSON.parse(readFileSync(join(process.cwd(), "src/rooms/contracts/bundled-agents.json"), "utf8")) as Record<string, { prompt: string }>;
const role = (id: string) => bundled[id]?.prompt ?? "";
const phase = (record: Record<string, unknown>, stage = "verification") =>
  ({ id: "ph_test1", title: "t", goal: "g", state: "active", stage, edition: 1, record } as unknown as Phase);

/** The real executors of a chain on a fake BB: the PM's checkout is a real git folder, the files a step writes land in it. */
const PROJECT = "d3-project", PM = "d3-pm", RUN = "d3-run";
function host() {
  const checkout = mkdtempSync(join(tmpdir(), "lp-d3-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  const writes: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Record<string, unknown> }) => {
      if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
      throw new Error(`unexpected host method ${call.method}`);
    }) as never,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => (threadId === PM ? { role: "pm", lanePilotRunId: RUN } : {}),
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-pm", sourceThreadId: PM, lifecycleOwnerThreadId: PM }),
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) },
      projects: { get: async () => ({ id: PROJECT, name: "Project", sources: [{ hostId: "local", path: checkout }] }) },
      files: { write: async (args: unknown) => { const input = args as { path: string; content: string }; mkdirSync(dirname(input.path), { recursive: true }); writeFileSync(input.path, input.content); writes.push(input.path.replace(checkout, "")); return { ok: true } as never; } },
    } as never,
  });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  const ctx = createCore(bb, db);
  const services = { stability: { loadParked: async () => [] } } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services) });
  registerPureActions(engine);
  registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  // Stands for the read-only auditor: the node before the real fs.write only hands over the document.
  engine.register("test.document", { reentrant: true, run: async () => ({ output: { document: "# UAT audit - p1 open", comment: "reviewed" } }) });
  const rt: ChainRuntime = { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN };
  /** Runs the given nodes of a chain on the real executors; `inputs` are its declared inputs. */
  const run = (nodes: Array<Record<string, unknown>>, inputs: Array<Record<string, unknown>>, given: Record<string, unknown>, map: Record<string, string>) => engine.start({
    workflow: parseWorkflow({ schemaVersion: 1, id: "d3-under-test", name: "d3", description: { en: "d3", ru: "d3" }, inputs, outputs: Object.keys(map).map((name) => ({ name, type: "json", required: false })),
      nodes: [...nodes, { id: "done", type: "action", action: "emit", map }], edges: [{ from: "start", to: String(nodes[0]!.id) }, ...nodes.slice(1).map((n, i) => ({ from: String(nodes[i]!.id), to: String(n.id) })), { from: String(nodes.at(-1)!.id), to: "done" }] }) as never,
    inputs: given, runtime: rt, link: { projectId: PROJECT, runId: RUN } }).done;
  return { checkout, writes, run, dispose: () => harness.lifecycle.dispose() };
}
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const WRITE_OK = { state: "accepted", merged_commits: ["c1"] };
const PLAN_OK = { status: "ok", clear: true, task_count: 1, risk: "low", already_met: false, objective: "fix", tasks: [{ id: "q1" }], task: { id: "q1" }, waves: [["q1"]] };

describe("parity d3 workflows a", () => {
  it("[sma:k_c_diagnose] where the project set phase.diagnose on, a failed verdict starts a parallel diagnosis of its gaps", async () => {
    const verdict = { state: "failed", detail: "check p1 red; check p2 red", inputSha: "sha1", at: 1 };
    const failed = phase({ diagnose: true, verification: { verdict } });
    expect(autoDue(failed)).toEqual({ kind: "diagnose" });
    const inputs = autoInputs(failed, { kind: "diagnose" }) as { mode: string; symptom: string[]; session: string };
    expect(inputs.mode).toBe("from_failures");
    expect(inputs.symptom.length).toBeGreaterThan(0);
    expect(inputs.session).toContain("verdict-");
    // Default: no phase.diagnose (an older record has no field) goes straight to the replan, as on main.
    expect(autoDue(phase({ verification: { verdict } }))).toEqual({ kind: "replan" });
    expect(autoDue(phase({ diagnose: false, verification: { verdict } }))).toEqual({ kind: "replan" });
    // A passed verdict with a red acceptance line left from an earlier cycle is not a diagnosis.
    expect(autoDue(phase({ diagnose: true, acceptance: { lines: [{ id: "a1", ok: false }], at: 1, accepted: false }, verification: { verdict: { ...verdict, state: "passed" }, model: { state: "met" } } }))).toBeNull();
    // With a diagnosis already stored for this verdict's inputSha the machine replans instead of diagnosing again.
    const diagnosed = phase({ diagnose: true, verification: { verdict, diagnosis: { inputSha: "sha1", diagnoses: [], diagnosis: "cause", at: 2 } } });
    expect(autoDue(diagnosed)).toEqual({ kind: "replan" });
    const r = await runSim("debug", { input: { mode: "from_failures", symptom: ["check p1 red", "check p2 red"] },
      stubs: { diagnose: [{ status: "confirmed", root_cause: "c1", confidence: 80, fix_direction: "f" }, { status: "partial", root_cause: "c2", confidence: 40, fix_direction: "f2" }] } });
    expect(pathOf(r)).toBe("ask_symptoms diagnose diagnosed");
    expect((out(r) as { diagnoses: unknown[] }).diagnoses.length).toBe(2);
    // Seven failures no longer end the run with guard:maxFanOut: the first six are diagnosed.
    const many = await runSim("debug", { input: { mode: "from_failures", symptom: Array.from({ length: 7 }, (_, i) => `check c${i} red`) },
      stubs: { diagnose: { status: "confirmed", root_cause: "c", confidence: 80, fix_direction: "f" } } });
    expect((out(many) as { diagnoses: unknown[] }).diagnoses.length).toBe(6);
    // A debug run started the old way (one symptom, no failures list, no session) takes the same path as on main.
    const old = await runSim("debug", { input: { symptom: "CSV import crashes with 'Cannot read properties of undefined' on files with an empty last line" },
      stubs: { investigate: { status: "confirmed", confidence: 82, pressure_pass: true, contradictions: 0, affected_files: ["a.ts:1"], refuted: 1, root_cause: "c", fix_direction: "f" }, verify_cause: { confirmed: true } } });
    expect(pathOf(old)).toBe("ask_symptoms investigate verify_cause confirmed");
    expect(old.skipped).toEqual(["ask_symptoms", "verify_cause"]);
    expect(old.called("session")).toEqual([]);
    expect(old.called("diagnose")).toEqual([]);
  });

  it("[sma:k_c_diagnose] a diagnosis that fails spends no try, never calls exhausted and the verdict is replanned as on main", async () => {
    const verdict = { state: "failed", detail: "check p1 red", inputSha: "sha1", at: 1 };
    let phaseNow = phase({ diagnose: true, train: true, auto: { kind: "diagnose", wfRunId: "wf1", startedAt: 1 }, autoFailures: { diagnose: 1 }, autoFailuresTotal: { diagnose: 4 }, autoFailuresVersion: "0.0.1", verification: { verdict } });
    const calls: string[] = [];
    const auto = createAutoStages({ log: () => undefined }, { workflowEngine: { get: () => ({ runId: "wf1", status: "failed", output: null, error: "the debugger said no", reason: null, waiting: [], stopped: false }) } as never },
      { exhausted: async () => { calls.push("exhausted"); }, api: {} as never, get: () => phaseNow, save: (_id: string, record: unknown) => { phaseNow = { ...phaseNow, record } as Phase; }, book: (_p: unknown, _s: unknown, kind: string) => { calls.push(`book ${kind}`); },
        writeDocs: async () => ({ written: [] }), runtime: () => ({}), pmIdle: async () => true, now: () => 7, version: "0.0.1" } as never);
    await auto.step(phaseNow);
    expect(calls).toEqual(["book auto_failed"]);
    expect(phaseNow.record.autoFailures).toEqual({ diagnose: 1 });
    expect(phaseNow.record.autoFailuresTotal).toEqual({ diagnose: 4 });
    expect(phaseNow.record.auto).toBeUndefined();
    expect(phaseNow.record.verification?.diagnosis).toEqual({ inputSha: "sha1", diagnoses: [], diagnosis: "", at: 7 });
    expect(autoDue(phaseNow)).toEqual({ kind: "replan" });
    expect(AUTO_REPLANS).toBeGreaterThan(0);
  });

  it("[sma:k_wq_init] each quick flag adds its step: discuss, research, validate, full write", async () => {
    const wf = workflow("issue-quick");
    for (const flag of ["full", "validate", "discuss", "research"]) expect(wf.inputs[flag]?.default).toBe(false);
    const stubs = { plan: PLAN_OK, write: WRITE_OK, "write-full": WRITE_OK, "lp.review": { critical_count: 0, high_count: 0, findings: [] }, state: { ok: true, note: "", comment: "done" }, validate: { verdict: "ok", notes: "" }, research: { notes: "files a.ts" } };
    expect(pathOf(await runSim("issue-quick", { input: { title: "t", text: "x", validate: true }, stubs }))).toBe("class plan validate lint write review state closed_reviewed");
    expect(pathOf(await runSim("issue-quick", { input: { title: "t", text: "x", full: true }, stubs }))).toBe("class plan validate lint write-full review state closed_reviewed");
    expect(pathOf(await runSim("issue-quick", { input: { title: "t", text: "x", research: true }, stubs }))).toBe("class research plan lint write state closed");
    expect(pathOf(await runSim("issue-quick", { input: { title: "t", text: "x", discuss: true }, stubs, humans: { discuss: { answer: "the label", answer_kind: "answered" } } }))).toBe("class discuss plan lint write state closed");
  });

  it("[sma:k_wq_research] the research flag inserts the research step and the plan sees its notes", async () => {
    expect(node("issue-quick", "plan").prompt).toContain("research.notes");
    const stubs = { plan: PLAN_OK, write: WRITE_OK, research: { notes: "files a.ts" } };
    const withIt = await runSim("issue-quick", { input: { title: "t", text: "x", research: true }, stubs });
    expect(pathOf(withIt)).toContain("research");
    const without = await runSim("issue-quick", { input: { title: "t", text: "x" }, stubs });
    expect(pathOf(without)).not.toContain("research");
  });

  it("[sma:k_wq_review] a reviewed quick change gets the review as advice, never a block; with the old inputs there is no review", async () => {
    const stubs = { plan: PLAN_OK, write: WRITE_OK, "lp.review": { critical_count: 0, high_count: 1, findings: [{ severity: "high", file: "a.ts:3" }] }, state: { ok: true, note: "", comment: "done" } };
    const r = await runSim("issue-quick", { input: { title: "t", text: "x", validate: true }, stubs: { ...stubs, validate: { verdict: "ok", notes: "" } } });
    expect(pathOf(r)).toBe("class plan validate lint write review state closed_reviewed");
    const output = out(r) as { status: string; review_findings: unknown[] };
    expect(output.status).toBe("closed");
    expect(output.review_findings.length).toBe(1);
    expect(node("issue-quick", "review").join.policy).not.toBe("all");
    // Old inputs: node for node what main runs; lp.review is never entered and the comment is main's.
    const old = await runSim("issue-quick", { input: { title: "t", text: "x" }, stubs });
    expect(pathOf(old)).toBe("class plan lint write state closed");
    expect(old.skipped).toEqual([]);
    expect(old.called("lp.review")).toEqual([]);
    expect(old.called("review")).toEqual([]);
    // The STATE.md row runs for every accepted quick task (SMA k_wq_state), reviewed or not.
    expect(old.called("state")).toHaveLength(1);
    expect((out(old) as { comment: string }).comment).toBe("quick path: built and verified");
    const medium = await runSim("issue-quick", { input: { title: "t", text: "x" }, stubs: { ...stubs, plan: { ...PLAN_OK, risk: "medium" }, "write-medium": WRITE_OK } });
    expect(pathOf(medium)).toBe("class plan lint write-medium state closed");
  });

  it("[sma:k_wq_state] a finished quick task leaves one table row in STATE.md, only where STATE.md exists", async () => {
    const first = quickRow("---\nphase: \"a\"\nstage: \"x\"\n---\n# State\n", { date: "2026-11-10", task: "fix typo", commit: "abc123" })!;
    expect(first).toContain("## Quick Tasks Completed");
    expect(first).toContain("| 2026-11-10 | fix typo | abc123 |");
    const second = quickRow(first, { date: "2026-11-10", task: "fix icon", commit: "def456" })!;
    expect(second.match(/## Quick Tasks Completed/g)!.length).toBe(1);
    expect(second).toContain("| 2026-11-10 | fix icon | def456 |");
    expect(second).toContain('phase: "a"');
    expect(second).toContain("# State");
    // The title cannot break the table or open a heading.
    const hostile = quickRow(first, { date: "2026-11-10", task: "# big\n## head | cell\r\n  x", commit: "c" })!;
    expect(hostile).toContain("| 2026-11-10 | big ## head / cell x | c |");
    expect(hostile.split("\n").filter((line) => /^#{1,6} /.test(line))).toEqual(["# State", "## Quick Tasks Completed"]);
    // No STATE.md: nothing is made, in the pure function and in the executor's edit (the read exits 3 when the file is missing).
    expect(quickRow(null, { date: "d", task: "t", commit: "c" })).toBeNull();
    expect(quickStateEdit({ exitCode: 3, stdout: "" }, { date: "d", task: "t", commit: "c" })).toBeNull();
    const edit = quickStateEdit({ exitCode: 0, stdout: "# State\n" }, { date: "d", task: "t", commit: "c" })!;
    expect(edit.content).toContain("| d | t | c |");
    expect(edit.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
    // The executor, real, on a checkout without STATE.md: it writes nothing, creates no folder, commits nothing and does not block the closing.
    const t = host();
    dispose = t.dispose;
    const state = () => t.run([{ id: "review", type: "action", action: "test.document", out: { document: "string", comment: "string" } }, node("issue-quick", "state")], [{ name: "title", type: "string", required: false }], { title: "fix | typo\n# x" }, { ok: "state.ok", note: "state.note" });
    const none = await state();
    expect(none.error ?? "").toBe("");
    expect(none.status).toBe("succeeded");
    expect(none.output).toEqual({ ok: true, note: "no STATE.md in the project: nothing written" });
    expect(t.writes).toEqual([]);
    expect(existsSync(join(t.checkout, ".agents"))).toBe(false);
    // An empty STATE.md that exists still gets its table.
    expect(quickStateEdit({ exitCode: 0, stdout: "" }, { date: "d", task: "t", commit: "c" })!.content).toContain("| d | t | c |");
  });

  it("[sma:k_pl_debug] an existing debug session file resumes the run, a new one starts open", async () => {
    // With a session set the file decides the path: found resumes without asking the symptoms, new asks them once.
    const resumed = await runSim("debug", { input: { session: "csv-crash" }, stubs: { session: { found: true, path: ".agents/planning/debug/csv-crash.md" }, investigate: { status: "confirmed", confidence: 80, pressure_pass: true, contradictions: 0, affected_files: ["a.ts:1"], refuted: 0, root_cause: "c", fix_direction: "f" }, verify_cause: { confirmed: true } } });
    expect(pathOf(resumed)).toBe("ask_symptoms session investigate verify_cause confirmed");
    expect(node("debug", "investigate").prompt).toContain(".agents/planning/debug/");
    const fresh = await runSim("debug", { input: { session: "new-one" }, stubs: { session: { found: false, path: ".agents/planning/debug/new-one.md" }, investigate: { status: "inconclusive", confidence: 10, refuted: 0, pressure_pass: true, contradictions: 0, affected_files: [], root_cause: "unknown", fix_direction: "none" } }, humans: { ask_symptoms_new: { answer: "s", answer_kind: "answered" } } });
    expect(fresh.summary.error ?? "").toBe("");
    expect(pathOf(fresh)).toBe("ask_symptoms session ask_symptoms_new investigate inconclusive");
    // The file lp.debug_session writes: the gaps from a phase (an array) one per line, never «—»; the name stays inside .agents/planning/debug/.
    const doc = debugSessionDoc("verdict-ab12", ["check p1 red", "acceptance a2"]);
    expect(doc).toContain("Status: open");
    expect(doc).toContain("check p1 red\nacceptance a2");
    expect(doc).not.toContain("## Symptom\n\n—");
    expect(debugSessionDoc("s", "")).toContain("## Symptom\n\n—");
    expect(debugSessionDoc("s", "one string")).toContain("one string");
    expect(debugSessionSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(debugSessionSlug("a/b\\c..d")).toBe("a-b-c.d");
    expect(debugSessionSlug("..")).toBe("");
    expect(debugSessionSlug("verdict-0123456789ab")).toBe("verdict-0123456789ab");
    // The executor, real: a phase's array symptom is written one gap per line; a second run finds the file and resumes; a hostile name stays inside the folder.
    const t = host();
    dispose = t.dispose;
    const session = (slug: string) => t.run([node("debug", "session")], [{ name: "session", type: "string", required: false }, { name: "symptom", type: "json", required: false }], { session: slug, symptom: ["check p1 red", "acceptance a2"] }, { found: "session.found", path: "session.path" });
    const first = await session("verdict-0123456789ab");
    expect(first.status).toBe("succeeded");
    expect(first.output).toEqual({ found: false, path: ".agents/planning/debug/verdict-0123456789ab.md" });
    expect(readFileSync(join(t.checkout, ".agents/planning/debug/verdict-0123456789ab.md"), "utf8")).toContain("check p1 red\nacceptance a2");
    expect((await session("verdict-0123456789ab")).output).toEqual({ found: true, path: ".agents/planning/debug/verdict-0123456789ab.md" });
    const hostile = await session("../../../escape");
    expect((hostile.output as { path: string }).path).toBe(".agents/planning/debug/escape.md");
    expect(existsSync(join(t.checkout, "escape.md"))).toBe(false);
    expect(t.writes.every((path) => path.startsWith("/.agents/planning/debug/"))).toBe(true);
    for (const bad of ["../x", "a/../../b", "/abs", "x\0y", "..\\..\\y"]) expect(`.agents/planning/debug/${debugSessionSlug(bad)}.md`).toMatch(/^\.agents\/planning\/debug\/[A-Za-z0-9._-]+\.md$/);
  });

  it("[sma:k_c_audituat] audit-uat: the read-only auditor returns the text, an fs.write node writes UAT-AUDIT.md", async () => {
    const audit = node("audit-uat", "audit");
    expect(audit.role).toBe("auditor");
    expect(audit.prompt).not.toMatch(/then write \.agents/i);
    expect(Object.keys(audit.out)).toEqual(expect.arrayContaining(["open_count", "document"]));
    const write = node("audit-uat", "write");
    expect(write.action).toBe("fs.write");
    expect(write.path).toBe(".agents/planning/");
    expect(write.contents).toEqual({ "UAT-AUDIT.md": "{{audit.document}}" });
    const r = await runSim("audit-uat", { input: {}, stubs: { audit: { open_count: 2, document: "# UAT audit\n- p1 open" }, goal_check: { ok: true, verdict: "pass", reason: "", details: {} } } });
    expect(pathOf(r)).toBe("audit write goal_check done");
    expect((out(r) as { open_count: number }).open_count).toBe(2);
    // The write node, real: it puts the auditor's text into .agents/planning/UAT-AUDIT.md of the checkout and names the path.
    const t = host();
    dispose = t.dispose;
    const done = await t.run([{ id: "audit", type: "action", action: "test.document", out: { document: "string" } }, write], [], {}, { audit_path: "write.audit_path" });
    expect(done.status).toBe("succeeded");
    expect(done.output!.audit_path).toBe(".agents/planning/UAT-AUDIT.md");
    expect(readFileSync(join(t.checkout, ".agents/planning/UAT-AUDIT.md"), "utf8")).toBe("# UAT audit - p1 open");
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

  const ANALYZE_STUBS = { gather: { anchors: [], modules: [], conventions: [], summary: "s", stack: ["ts"], features: ["f"] },
    assess: { decisions: [], risks: [], scores_min: 1, scope_verdict: "small", recommendation: "go", confidence: 90, stalled: true, pressure_pass: true, open_questions: ["auth?", "cache?"], residual_risks: [], appetite: "s", no_gos: [], pitfalls: [] },
    advise: { area: "a?", options: [], pick: "one", advice: [{ option: "one" }] } };

  it("[sma:k_wdi_gray] the owner chooses which gray areas get discussed, only when ask_owner is on", async () => {
    const r = await runSim("lp.analyze", { input: { goal: "g", ask_owner: true, owner_card: "card" }, stubs: ANALYZE_STUBS,
      humans: { choose: { answer: "auth?", answer_kind: "chosen", chosen: ["auth?"], deferred: ["cache?"] } } });
    expect(pathOf(r)).toBe("gather assess choose advise done");
    expect((out(r) as { deferred_by_owner: string[] }).deferred_by_owner).toEqual(["cache?"]);
    const doc = contextDoc(phase({}), { open_questions: ["auth?", "cache?"], deferred_by_owner: ["cache?"], chosen: ["auth?"] });
    expect(doc.content).toContain("cache? — deferred by the owner");
    // Default (ask_owner false, even with an owner card): node for node what main runs, neither choose nor advise is visited.
    const plain = await runSim("lp.analyze", { input: { goal: "g", owner_card: "senior dev" }, stubs: ANALYZE_STUBS });
    expect(pathOf(plain)).toBe("gather assess done");
    expect(plain.skipped).toEqual([]);
    expect(plain.called("choose")).toEqual([]);
    expect(plain.called("advise")).toEqual([]);
    expect(plain.called("advise:child")).toEqual([]);
    // A timeout of the owner's form (the engine gives only answer and answer_kind) means all chosen and does not fail the run.
    const timeout = await runSim("lp.analyze", { input: { goal: "g", ask_owner: true, owner_card: "card" }, stubs: ANALYZE_STUBS,
      humans: { choose: { answer: "", answer_kind: "timeout", chosen: undefined, deferred: undefined } } });
    expect(pathOf(timeout)).toBe("gather assess choose advise done");
    expect(timeout.summary.status).toBe("succeeded");
    // advise reads no value the timeout did not give: every gray area is advised.
    expect(timeout.called("advise:child").length).toBe(2);
    expect(node("lp.analyze", "advise").child.prompt).toContain("{{choose.answer_kind}}");
    expect((out(timeout) as { deferred_by_owner?: string[] }).deferred_by_owner ?? []).toEqual([]);
    // The context document of a timed-out choice defers nothing.
    expect(contextDoc(phase({}), { open_questions: ["auth?", "cache?"] }).content).not.toContain("deferred by the owner");
  });

  it("[sma:k_wdi_advisor] with a developer profile an advisor compares each chosen area; more than six areas are cut, not failed", async () => {
    const advised = await runSim("lp.analyze", { input: { goal: "g", ask_owner: true, owner_card: "senior dev" }, stubs: ANALYZE_STUBS, humans: { choose: { answer: "both", answer_kind: "chosen", chosen: ["auth?", "cache?"], deferred: [] } } });
    expect(pathOf(advised)).toContain("advise");
    const skipped = await runSim("lp.analyze", { input: { goal: "g", ask_owner: true, owner_card: "" }, stubs: ANALYZE_STUBS, humans: { choose: { answer: "", answer_kind: "all" } } });
    expect((out(skipped) as { advice: unknown[] }).advice).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => `q${i}?`);
    const wide = await runSim("lp.analyze", { input: { goal: "g", ask_owner: true, owner_card: "c" }, stubs: { ...ANALYZE_STUBS, assess: { ...ANALYZE_STUBS.assess, open_questions: many } }, humans: { choose: { answer: "", answer_kind: "all" } } });
    expect(wide.summary.status).toBe("succeeded");
    expect(wide.called("advise:child").length).toBe(6);
    // With nothing set the analysis gets main's two inputs.
    const off = autoInputs(phase({}, "discussion"), { kind: "analyze" }, undefined, null, "card") as Record<string, unknown>;
    expect(Object.keys(off).sort()).toEqual(["depth", "goal"]);
    // owner.words alone (an install that has it on today) changes nothing: the question and the advisers need phase.gray_areas too.
    expect(Object.keys(autoInputs(phase({ ownerWords: true }, "discussion"), { kind: "analyze" }, undefined, null, "card") as Record<string, unknown>).sort()).toEqual(["depth", "goal"]);
    expect(Object.keys(autoInputs(phase({ grayAreas: true }, "discussion"), { kind: "analyze" }, undefined, null, "card") as Record<string, unknown>).sort()).toEqual(["depth", "goal"]);
    const on = autoInputs(phase({ ownerWords: true, grayAreas: true }, "discussion"), { kind: "analyze" }, undefined, null, "card") as Record<string, unknown>;
    expect(on.ask_owner).toBe(true);
    expect(on.owner_card).toBe("card");
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
    // lp.docs-maintenance declares the same input (SMA k_ag_docwriter) and hands it to the stage.
    expect(workflow("lp.docs-maintenance").inputs.assignment.default).toBe("");
    expect(docsMaintenancePrompt({ since: "yesterday", pages: [], pageCap: 3, assignment: "write a runbook for deploy" })).toContain("owner_assignment");
    expect(docsMaintenancePrompt({ since: "yesterday", pages: [], pageCap: 3 })).not.toContain("owner_assignment");
  });
});
