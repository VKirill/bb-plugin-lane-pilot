// Probe of scenes/sma_r17.py: drives the REAL roles of THIS checkout (the commit under drill) and prints what they did as one JSON line. It judges
// nothing: the scene compares each value with the card's expected result and prove()s it. No model, no hub write: the graphs run on the real
// engine with the model nodes answered by stubs (what a role is given, which field carries its answer and where the graph sends it are observed).
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import { nightlyDocsPrompt } from "../../../src/rooms/docs/docs";
import { lintCitationClaims } from "../../../src/rooms/docs/docs-lint";
import { buildAcceptanceCard } from "../../../src/rooms/acceptance/card";
import { getBaseline } from "../../../src/rooms/baseline";
import { fragmentJudgeVia } from "../../../src/rooms/anamnesis/fragments";
import { effectiveGroup, roleProfilePolicy } from "../../../src/rooms/contracts/helper-context";
import { resolveSpawnModel } from "../../../src/rooms/platform/server/spawn-model";
import { roleDefaultModel } from "@lane-pilot/models";
import { compileMainAgentProfile } from "../../../src/rooms/native-agent/agent-profile";
import { sessionOverrideAgentsJson } from "../../../src/rooms/native-agent/native-agent-definition";
import { withoutCodeWritingSubagents } from "../../../src/rooms/native-agent/native-agent-overlay";
import { blindVerdict } from "../../../src/rooms/phase/logic";
import { ANIMATOR_LAW, conclusionText, piecePlan, uiContractGap, validationGaps } from "../../../src/rooms/phase/stages";
import { parseQaVerdict } from "../../../src/rooms/qa/server/qa-thread";
import { DOCUMENTARY_AGENTS, pretaskDecision } from "../../../src/rooms/session-hooks/logic";
import { writerBriefSegments } from "../../../src/rooms/writer/server/writer-task";
import { agentRequest, roleSpec } from "../../../src/rooms/workflow/server/workflow-agent";
import { REDUCERS } from "../../../packages/workflow-engine/src/reducers";
import { world } from "../../../tests/baseline/world";
import { chainStore, runSim } from "../../../tests/workflow/chain-harness";

type AgentNode = Extract<GraphNode, { type: "agent" }>;
const s: Record<string, any> = {};
const finding = (severity: string, file: string) => ({ file, line: 12, severity, evidence: `${file}: return value of save() ignored`, dimension: "correctness" });
const outOf = (r: { summary: { output: unknown } }) => (r.summary.output ?? {}) as Record<string, any>;
const ran = (r: { steps: Array<{ node_id: string; state: string }> }) => r.steps.filter((step) => step.state === "succeeded").map((step) => step.node_id).filter((id) => !/:(fan|child)$/.test(id));

async function spawnOf(workflowId: string, nodeId: string) {
  const flow = (await chainStore()).get(workflowId)!.workflow;
  const node = flow.nodes.find((candidate) => candidate.id === nodeId) as AgentNode;
  const ctx = { runtime: { pmThreadId: "t", projectId: "", runId: "r", ctx: {}, services: {} }, workflow: flow, node, nodeId, runId: "wfrun", stepKey: `${nodeId}#1`, spawnKey: "k", mode: "standard",
    signal: new AbortController().signal, input: { with: {}, via: { mode: "artifact", fromStep: null } }, goals: [], reground: false, render: (text: string) => text, template: (value: unknown) => value } as unknown as StepContext<never>;
  const request = agentRequest(ctx as never, node);
  const spec = roleSpec(request.role);
  return { role: request.role, helper: spec.helper, readOnly: spec.readOnly, notes: spec.editable(".agents/research/x.md"), src: spec.editable("src/app.ts"), prompt: request.prompt, fields: Object.fromEntries(request.fields.map((field) => [field.name, field.type])), consumes: (node.consumes ?? []).map((use) => use.from) };
}
function sessionOf(agentId: string) {
  const compiled = compileMainAgentProfile(agentId);
  const definition = Object.values(JSON.parse(sessionOverrideAgentsJson({ agentId, edited: false, compiled })!) as Record<string, { tools?: string[]; skills?: string[] }>)[0]!;
  return { writes: (definition.tools ?? []).filter((tool) => ["Write", "Edit", "NotebookEdit", "MultiEdit"].includes(tool)), reads: (definition.tools ?? []).filter((tool) => ["Read", "Grep", "WebSearch"].includes(tool)), skills: definition.skills ?? [] };
}

// ---- sessions that only read and report (n1368 n1379 n1387 n1394) ----
s.sessions = Object.fromEntries(["framework-selector", "nyquist-auditor", "doc-classifier", "advisor-researcher", "ai-researcher", "eval-planner"].map((id) => [id, sessionOf(id)]));
const piece = (id: string, commands: string[]) => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { verification: commands.map((command) => ({ command })) } }) as never;
s.gaps = validationGaps([piece("p1", ["test -f out.txt", "ls dist"]), piece("p2", ["npm test", "test -f out.txt"])]).map((line) => line.slice(0, 40));

// ---- the ai-integration-phase graph (n1368 n1369 n1370 n1371) ----
const aiStubs = { select: { framework: "langchain", options: [{ name: "langchain" }] }, research: { domain_notes: "expert criteria" }, spec: { spec_path: "x/AI-SPEC.md" }, check: [{ ok: false, gaps: ["no guardrails"] }, { ok: true, gaps: [] }] };
const ai = await runSim("ai-integration-phase", { input: { goal: "rank" }, stubs: aiStubs });
s.ai = { path: ai.path.join(" "), out: outOf(ai), evalPlanCalls: ai.called("eval_plan").length };
s.research = await spawnOf("ai-integration-phase", "research");
const evalPlan = await spawnOf("ai-integration-phase", "eval_plan");
s.evalPlan = { helper: evalPlan.helper, readOnly: evalPlan.readOnly, fields: evalPlan.fields, named: [...evalPlan.prompt.matchAll(/research\.(\w+)/g)].map((match) => match[1]) };
s.spec = { consumes: (await spawnOf("ai-integration-phase", "spec")).consumes };
s.select = { readOnly: (await spawnOf("ai-integration-phase", "select")).readOnly, fields: (await spawnOf("ai-integration-phase", "select")).fields };

// ---- the phase's own text (n1372 n1373 n1377) ----
const task = { schema_version: 2, id: "p1", display_title: "p1", kind: "feature", title: "p1", risk: "low", lane: "writer", project_cwd: "/ws", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["a.txt"], owns_paths: ["a/**"], never_touch: [], acceptance: ["a.txt exists"], verification: [{ command: "test -f a.txt" }], depends_on: [], objective: "o" };
const items = [{ id: "a", title: "A", wave: 1, promise: { given: "g", when: "it is opened", then: "A works" }, task: {} }, { id: "b", title: "B", wave: 1, promise: { given: "g", when: "it is closed", then: "B works" }, task: {} }] as never[];
s.executor = {
  brief: writerBriefSegments(task as never).map((segment) => segment.text).join("\n").includes("Lane Pilot commits and merges your accepted changes"),
  summary: conclusionText({ id: "ph_9", title: "T", goal: "g", record: { plan: { items } } } as never, [], new Map([["a", { taskId: "task_a", state: "accepted" }], ["b", { taskId: "task_b", state: "blocked" }]]) as never).split("\n").filter((line) => line.startsWith("- a (") || line.startsWith("- b (") || line.startsWith("# Summary")),
};
const mpiece = (title: string, when: string) => ({ id: title, title, wave: 1, promise: { given: "a screen", when, then: "it holds" }, task: { owns_paths: ["src/ui/x.css"] } }) as never;
const ph = (pieceNotes: boolean) => ({ id: "ph_1", title: "t", record: { pieceNotes } }) as never;
s.animator = { motion: piecePlan(ph(true), mpiece("HUD motion", "the panel moves")).includes(`Motion (the animator's law): ${ANIMATOR_LAW}`), plain: piecePlan(ph(true), mpiece("Copy", "the label stays")).includes("animator's law"), noNotes: piecePlan(ph(false), mpiece("HUD motion", "the panel moves")).includes("animator's law") };
const bitem = (id: string) => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id, kind: "feature", acceptance: ["a"], verification: [{ command: "npm test" }] } }) as never;
const fact = (over: Record<string, unknown> = {}) => ({ taskId: "hud", state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", ...over }) as never;
const green = { state: "passed", headSha: "abc" };
s.verdict = { failed: blindVerdict([bitem("hud")], new Map([["hud", fact({ planFact: "failed" })]]), green, 1), passed: blindVerdict([bitem("hud")], new Map([["hud", fact()]]), green, 1).state, again: blindVerdict([bitem("hud")], new Map([["hud", fact()]]), green, 9).inputSha === blindVerdict([bitem("hud")], new Map([["hud", fact()]]), green, 1).inputSha };

// ---- fixing and debugging (n1374 n1375 n1376) ----
const FINDINGS = [finding("high", "src/a.ts"), finding("medium", "src/b.ts")];
const plan = { status: "ok", tasks: [{ id: "fix-a", objective: "fix a" }], waves: [["fix-a"]] };
const fix = await runSim("review-fix", { input: { goal: "fix the review", findings: FINDINGS }, stubs: { plan_fix: plan, plan_fix2: { ...plan, tasks: [{ id: "fix-b", objective: "fix b" }], waves: [["fix-b"]] }, build_fix: { merged_commits: ["c1"] }, build_fix2: { merged_commits: ["c2"] }, re_review: [{ status: "rework", findings: [finding("high", "src/c.ts")], remaining_actionable: 1 }, { status: "pass", findings: [], remaining_actionable: 0 }] } });
s.fix = { planGaps: fix.called("plan_fix")[0]?.input, buildTasks: fix.called("build_fix")[0]?.input, secondGaps: fix.called("plan_fix2")[0]?.input, secondBuild: fix.called("build_fix2")[0]?.input, path: fix.path.join(" "), out: outOf(fix), firstReviewCalls: fix.called("first_review").length };
const investigate = await spawnOf("debug", "investigate");
const stand = { status: "confirmed", root_cause: "list[0] on empty", mechanism: "m", confidence: 80, evidence_path: "e.md", affected_files: ["src/save.ts"], fix_direction: "guard", pressure_pass: true, contradictions: 0 };
const dbg = await runSim("debug", { input: { symptom: "x".repeat(60) }, mode: "full", stubs: { investigate: stand, verify_cause: [{ confirmed: false, objections: ["cheaper"] }, { confirmed: true, objections: [] }] } });
const stuck = await runSim("debug", { input: { symptom: "x".repeat(60) }, mode: "full", stubs: { investigate: stand, verify_cause: { confirmed: false, objections: ["cheaper"] } } });
s.debug = { helper: investigate.helper, readOnly: investigate.readOnly, method: investigate.prompt.includes("No fix without a confirmed root cause") && investigate.prompt.includes("at most 3 hypotheses"), skills: roleProfilePolicy("debugger").skills, path: dbg.path.join(" "), out: outOf(dbg), stuckInvestigate: stuck.called("investigate").length, stuckStatus: outOf(stuck).status };

// ---- the whole-checking roles (n1378) ----
{
  const w = await world();
  await w.services.baseline.preflight(w.pendingTask("t1", ["test -f keep.txt", "test -f feature.txt", "grep -q line2 server.ts"]));
  const turned = w.services.baseline.afterMerge({ runId: "run1", taskId: "t1", mergeCommit: "abc", checks: [{ command: "test -f keep.txt", exitCode: 1 }, { command: "test -f feature.txt", exitCode: 1 }, { command: "grep -q line2 server.ts", exitCode: 1, hostError: true }] });
  s.baseline = { turned, after: getBaseline(w.db, "run1", "t1")!.after, card: buildAcceptanceCard(w.db, { runId: "run1", taskId: "t1" })!.baseline!.turnedRed };
  await w.dispose();
}

// ---- audit graphs (n1380 n1381 n1383 n1389 n1393 n1395 n1396 n1397) ----
const noPhase = await runSim("security-audit", { input: { tier: "standard" }, stubs: { recon: { found_entry_points: true } } });
const withPhase = await runSim("security-audit", { input: { tier: "standard", phase_id: "ph_a" }, stubs: { recon: { found_entry_points: true }, threat_model: { findings: [finding("high", "src/a.ts")] } } });
s.security = { plainCalls: noPhase.called("threat_model").length, plainSkipped: noPhase.skipped, phaseCalls: withPhase.called("threat_model").length };
const uiStubs = { capture: { status: "pass", screenshots: ["a.png"] }, audit: { score_40: 30, score_20: 14, findings: [] }, review_doc: { review_path: ".agents/ui/p/UI-REVIEW.md" } };
const uiOff = await runSim("ui-audit", { input: { url: "http://localhost:4173", review_file: false }, stubs: uiStubs });
const uiOn = await runSim("ui-audit", { input: { url: "http://localhost:4173" }, stubs: uiStubs });
s.uiAudit = { offSkipped: uiOff.skipped, offCalls: uiOff.called("review_doc").length, onCalls: uiOn.called("review_doc").length };
const flawed = await runSim("eval-review", { input: { phase_id: "ph_1" }, stubs: { review: { flawed: true, findings: [finding("high", "evals/gold.json")], review_path: "p.md" } } });
const sound = await runSim("eval-review", { input: { phase_id: "ph_1" }, stubs: { review: { flawed: false, findings: [], review_path: "p.md" }, goal_check: { ok: true, verdict: "pass" } } });
s.evalReview = { flawedPath: flawed.path.join(" "), flawedOut: outOf(flawed), soundPath: sound.path.join(" "), soundStatus: outOf(sound).status };
const acStubs = { analyze: { recommendation: "go_with_conditions", decisions: [{ id: "d1" }], risks: [], confidence: 77 }, report: { report_path: "reports/analysis-1.md" } };
const ac = await runSim("analyze-code", { input: { goal: "map", scope: "src/rooms/writer" }, stubs: acStubs });
const acQuick = await runSim("analyze-code", { input: { goal: "map", scope: "src/rooms/writer" }, mode: "quick", stubs: acStubs });
s.analyzeCode = { input: ac.called("analyze")[0]?.input, out: outOf(ac), quickDepth: acQuick.called("analyze")[0]?.input.depth };
const walk = [{ questions_without_anchor: 2, branches_walked: 3, qa: [], terminology: [] }, { questions_without_anchor: 0, branches_walked: 3, qa: [], terminology: [] }];
const grillOpen = await runSim("grill-plan", { input: { goal: "g", plan: "p" }, stubs: { walk, synth: { locked: ["L"], open: ["O"], deferred: [], risk_register: [] } } });
const grillDone = await runSim("grill-plan", { input: { goal: "g", plan: "p" }, stubs: { walk: walk[1]!, synth: { locked: ["L"], open: [], deferred: [], risk_register: [] } } });
s.grill = { walks: grillOpen.called("walk").length, openStatus: outOf(grillOpen).status, doneStatus: outOf(grillDone).status };
const analyze = await runSim("lp.analyze", { input: { goal: "g" }, stubs: { gather: { anchors: [], modules: [], conventions: [], summary: "s", stack: ["ts", "node"], features: ["tasks"] }, assess: { decisions: [], risks: [], scores_min: 3, scope_verdict: "small", recommendation: "go", confidence: 90, stalled: true, pressure_pass: true, open_questions: [], residual_risks: [], appetite: "s", no_gos: [], pitfalls: ["race"] } } });
s.analyze = { stack: outOf(analyze).stack, features: outOf(analyze).features };
const row = (item: unknown, data?: Record<string, unknown>, branch = 0) => ({ branch, item, ok: data !== undefined, ...(data ? { data } : { error: "x", blocked: false }) });
const rowsList = [row("q1", { subquestion: "q1", sources: [{ url: "u1" }, { url: "u2" }] }, 0), row("q2", { subquestion: "q2", sources: [{ url: "u1" }] }, 1), row("q3", { subquestion: "q3", sources: [] }, 2)];
s.reducer = (REDUCERS["reduce.web-research.search"] as (input: unknown) => unknown)({ rows: rowsList, results: rowsList.map((entry) => (entry as { data?: unknown }).data), failed: [], items: rowsList.map((entry) => entry.item) });
const roadStubs = { roadmap: { sessions: [{ id: "s1", intent: "login" }], mode: "single", session_count: 1, requirement_map: { R1: ["s1"] } }, sessions: { done_ids: ["s1"], blocked_ids: [], done_count: 1, blocked_count: 0 }, close: { status: "closed", report_path: "reports/close.md" } };
const badRoad = await runSim("roadmap-driven", { input: { goal: "g", requirements: "R1" }, stubs: { ...roadStubs, validate: { ok: false, errors: ["R1 maps to no session"], cycles: [] } } });
const goodRoad = await runSim("roadmap-driven", { input: { goal: "g", requirements: "R1" }, stubs: { ...roadStubs, validate: { ok: true, errors: [], cycles: [] } }, humans: { approve: { answer: "approve", answer_kind: "approve" } } });
s.roadmap = { badRoadmapCalls: badRoad.called("roadmap").length, badStatus: outOf(badRoad).status, goodStatus: outOf(goodRoad).status, goodDone: outOf(goodRoad).sessions_done };
const planStubs = { plan: { tasks: [{ id: "a", objective: "a" }, { id: "b", objective: "b" }, { id: "c", objective: "c" }], task_count: 3 }, plan_critic: { status: "pass" }, patterns: { patterns_md: "src/rooms/x.ts:10 — copy" } };
const planOn = await runSim("lp.plan", { input: { goal: "g", patterns: true }, stubs: planStubs });
const planQuick = await runSim("lp.plan", { input: { goal: "g", patterns: true }, mode: "quick", stubs: { plan: planStubs.plan } });
s.patterns = { ran: ran(planOn), planInput: planOn.called("plan")[0]?.input.patterns_md, out: outOf(planOn).patterns_md, quickCalls: planQuick.called("patterns").length };

// ---- docs, quality, profile, tools (n1382 n1384 n1385 n1386 n1391 n1398 n1399) ----
const verdictBlock = (cases: string) => `done\n\`\`\`json\n{"verdict":"passed","summary":"ok","cases":${cases}}\n\`\`\``;
s.qa = { blocked: parseQaVerdict(verdictBlock(`[{"case":"c1","viewport":"1280","result":"blocked"}]`)).verdict, none: parseQaVerdict("looks fine").summary, passed: parseQaVerdict(verdictBlock(`[{"case":"c1","viewport":"1280","result":"passed"}]`)).verdict };
const designRecord = (requirements: string[]) => ({ design: { decision: "needed", drawing: { paths: ["x/design/UI-SPEC.md"], sha256: "s" }, requirements } }) as never;
s.uiSpec = { ok: uiContractGap(designRecord(["actions", "accessibility"]), "# Spec\n\n## Actions\n\n## Accessibility notes\n"), gap: uiContractGap(designRecord(["actions", "accessibility"]), "# Spec\n\n## Actions\n") };
const withA = nightlyDocsPrompt({ since: "yesterday", hasDocs: true, changed: [], assignment: "write a runbook for deploy" });
s.docs = { withAssignment: withA.includes("owner_assignment") && withA.includes("write a runbook for deploy"), without: nightlyDocsPrompt({ since: "yesterday", hasDocs: true, changed: [] }).includes("owner_assignment") };
const page = (text: string) => [{ path: "docs/components/widget.md", content: `---\ntitle: Widget\ntype: component\n---\n\n${text}\n` }];
const claim = "The `parseThing` helper builds the row src/parser.ts:3-5.";
const lines = (found: boolean) => async () => (found ? "line\nconst parseThing = () => 1\nline" : "line\nconst other = 1\nline");
s.citation = { absent: (await lintCitationClaims(page(claim), lines(false))).map((finding) => finding.rule), present: (await lintCitationClaims(page(claim), lines(true))).length };
const judge = fragmentJudgeVia(async () => JSON.stringify({ fragments: [{ id: "f1", kind: "skill", about_owner: true, sensitive: false, confidence: "high" }, { id: "f2", kind: "hobby", about_owner: true, sensitive: false, confidence: "low" }, { id: "f3", kind: "fact", about_owner: true, sensitive: true, confidence: "medium" }] }));
s.fragments = await judge(["I write TypeScript every day", "maybe I like chess", "my daughter has asthma"]);
s.pmTools = { narrowed: withoutCodeWritingSubagents("dev-orchestrator", ["Agent", "Task", "Read"]), listed: withoutCodeWritingSubagents("dev-orchestrator", ["Agent(Explore, general-purpose, Plan)"]), other: withoutCodeWritingSubagents("copy-lead", ["Agent"]) };
s.hook = { refused: pretaskDecision({ role: "writer", kind: "general-purpose", background: false, spawned: 0 }), documentary: DOCUMENTARY_AGENTS.map((kind) => pretaskDecision({ role: "writer", kind, background: false, spawned: 0 }).deny ?? null) };

// ---- batch b: n1400 n1401 ----
const fgCall = (role: string, background: boolean, spawned: number) => { const d = pretaskDecision({ role, kind: "Explore", background, spawned }); return { deny: d.deny ?? null, spawned: d.spawned }; };
s.foreground = { pmBackground: fgCall("pm", true, 2), writerBackground: fgCall("writer", true, 2), pmForeground: fgCall("pm", false, 2), writerForeground: fgCall("writer", false, 2) };
const modelOf = (role: string, over: Record<string, unknown> = {}) => resolveSpawnModel({ role, settings: {}, pm: null, catalog: null, ...over } as never);
s.resolve = {
  skills: Object.fromEntries((["writer", "docs-maintainer", "browser-qa", "plan-critic"] as const).map((role) => [role, effectiveGroup(role, "skills")])),
  owner: effectiveGroup("writer", "skills", { skills: { mode: "allow", names: ["only-this"] } }),
  models: Object.fromEntries((["writer", "docs-maintainer", "plan-critic"] as const).map((role) => [role, { got: [modelOf(role).providerId, modelOf(role).model], row: [roleDefaultModel(role as never).providerId, roleDefaultModel(role as never).model] }])),
  pinned: [modelOf("docs-maintainer", { pinned: { provider: "codex", model: "gpt-x" } }).model, modelOf("docs-maintainer", { pinned: { provider: "codex", model: "gpt-x" } }).source],
};

process.stdout.write(`${JSON.stringify(s)}\n`);
process.exit(0);
