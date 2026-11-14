// Probe of scenes/sma_r22.py: runs the real planning-folder code of THIS checkout (the commit under drill) and prints what it returned as one
// JSON line. It judges nothing: the scene compares each value with the node card's expected result and prove()s it. No model, no hub write.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { docsCompletenessGaps } from "../../../src/rooms/docs/docs-lint";
import { fragmentJudgeVia, parseFragments } from "../../../src/rooms/anamnesis/fragments";
import { backlogBoard, type TodoMeta } from "../../../src/rooms/backlog/logic";
import { createCore } from "../../../src/rooms/core/server/core";
import { codeFactsState } from "../../../src/rooms/platform/code-facts";
import { openDatabase } from "../../../src/rooms/plugin-db";
import { createRun } from "../../../src/rooms/storage/runs-store";
import { savePhase } from "../../../src/rooms/phase/store";
import { markRoadmap, markUatLine, nextRoadmapRow, planText, reviewDoc, specText, stageInit, stateBlockText, templateFill, threatGap, uatState, uatText, validationGaps, STATE_BLOCK_END, STATE_BLOCK_START } from "../../../src/rooms/phase/stages";
import { loadProjectSettings } from "../../../src/rooms/storage";
import { verdictInventory } from "../../../src/rooms/tools/server/verdicts";
import { createPhaseDriver } from "../../../tests/phase-driver";
import { runSim } from "../../../tests/workflow/chain-harness";

const clip = (value: unknown, max: number) => String(typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value)).trim().slice(0, max);
const FOLDER = ".agents/phases/ph_a1";
const rec = (over: Record<string, unknown> = {}) => over as never;
const item = (id: string, wave: number, then: string, task: Record<string, unknown> = {}) => ({ id, title: id, wave, promise: { given: "a sheet", when: "summed", then }, task: { owns_paths: [`src/${id}.ts`], verification: [{ command: `npx vitest run tests/${id}.test.ts` }], ...task } });
const phase = (record: Record<string, unknown> = {}, stage = "planning") => ({ id: "ph_a1", title: "Sums", goal: "sums skip empty cells", stage: stage as never, record: rec(record) });

async function lessonIntoMemory() {
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = "off";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  const services = { runBudgets: { get: () => undefined }, readWriterWorkspaceFile: async ({ path }: { path: string }) => ({ sha256: sha256Hex(path), sizeBytes: 120, content: `# ${path}` }) };
  const { phases } = createPhaseDriver(createCore(bb, db), services as never);
  const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "sums skip empty cells" });
  savePhase(db, opened.id, { stage: "lessons", record: { ...phases.status(opened.id).phase.record, lessons: { needed: true, why: "a return" } }, at: 2 });
  const analysis = "The plan missed the empty-cell case; a check per promise would have caught it.";
  const input = JSON.stringify({ with: {}, via: { mode: "artifact", fromStep: "retro#1", fromThreadId: "thr_retro", handoff: analysis } });
  db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("wf_read", "retrospective", 1, "sha", "{}", "projA", "succeeded", 1, 1);
  db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,input_json,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("wf_read", "stage#1", "stage#1", "stage", 1, "succeeded", input, JSON.stringify({ executor: "agent", inputSha256: sha256Hex(input), threadId: "thr_stage" }), 1, 2, 2);
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory_fts WHERE project_id='projA'").get() as { n: number }).n;
  const before = count();
  const closed = phases.lessons({ phaseId: opened.id, analysis, reviewRun: "wf_read" });
  const content = (db.prepare("SELECT content FROM lane_pilot_memory_fts WHERE project_id='projA'").get() as { content: string } | undefined)?.content ?? "";
  return { before, after: count(), stage: closed.stage, text: content.slice(0, 80) };
}

function settingsLayers() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const put = (project: string, binding: string, key: string, value: unknown) => db.prepare("INSERT OR REPLACE INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,1,1)").run(project, binding, key, JSON.stringify(value));
  put("projA", "", "phase.branch", "milestone"); put("projA", "", "run.max_tokens", 5000); put("projA", "scope1", "phase.branch", "run-scoped");
  return { project: loadProjectSettings(db, "projA"), scoped: loadProjectSettings(db, "projA", ["scope1"]), none: loadProjectSettings(db, "projNone") };
}

const todo = (id: string, over: Partial<TodoMeta> = {}): TodoMeta => ({ id, title: id, status: "ready", priority: "medium", estimate: 3, dependsOn: [], created: "2026-11-01", ...over });
const HAND = "# Project state\r\n\r\n## Decisions\r\n\r\n### Storage\r\n- chose sqlite, do not change\r\n\r\n## Notes\r\nmy own notes";
const stateNext = stateBlockText(HAND, { phase: "1.1", stage: "planning" }, { Position: ["phase 1.1", "stage planning"], Decisions: ["use WAL"] });
const stateText = "text" in stateNext ? stateNext.text : "";
const stateOutside = stateText.slice(0, stateText.indexOf(STATE_BLOCK_START)) + stateText.slice(stateText.indexOf(STATE_BLOCK_END) + STATE_BLOCK_END.length);
const two = [item("p1", 1, "totals skip empty cells"), item("p2", 2, "the footer shows the total")];
const uat = uatText(phase({ plan: { items: two } }));
const uatMarked = markUatLine(uat, 2, false, "footer missing")!;
const questions = [{ id: "q1", stage: "planning", text: "t", blocking: true, askedAt: 1 }, { id: "q2", stage: "planning", text: "t", blocking: true, askedAt: 1, answer: "y" }];
const docs = [{ path: "docs/overview.md", content: "---\ntype: overview\n---\n" }, { path: "docs/architecture.md", content: "---\ntype: architecture\n---\n" }, { path: "docs/gotchas.md", content: "---\ntype: gotchas\n---\n" }] as never;
const risk = (security?: string, withDoc = false) => rec({ context: { docs: withDoc ? [{ path: `${FOLDER}/SECURITY.md`, sha256: "a", bytes: 1 }] : [], sha: "s", signedAt: 1, ...(security === undefined ? {} : { risks: { security } }) } });
const out = (result: { summary: { output?: unknown } }) => (result.summary.output ?? {}) as Record<string, unknown>;
const uiStubs = { capture: { status: "pass", screenshots: ["a.png"] }, audit: { score_40: 30, score_20: 14, findings: [], report_path: "audit.md" } };
const aiBase = { select: { framework: "langchain", options: [] }, research: { notes: "ok" }, spec: { spec_path: ".agents/phases/ph_a/AI-SPEC.md" } };

const ui = await runSim("ui-audit", { input: { url: "http://localhost:4173" }, stubs: { ...uiStubs, review_doc: { review_path: ".agents/ui/pricing/UI-REVIEW.md" } } });
const uiOff = await runSim("ui-audit", { input: { url: "http://localhost:4173", review_file: false }, stubs: uiStubs });
const evalFlawed = await runSim("eval-review", { input: { phase_id: "ph_a" }, stubs: { review: { findings: [], review_path: ".agents/phases/ph_a/EVAL-REVIEW.md", flawed: true } } });
const aiOk = await runSim("ai-integration-phase", { input: { goal: "rank" }, stubs: { ...aiBase, check: { ok: true, gaps: [] } } });
const aiBlocked = await runSim("ai-integration-phase", { input: { goal: "rank" }, stubs: { ...aiBase, check: { ok: false, gaps: ["no guardrails"] } } });
const lesson = await lessonIntoMemory();

console.log(JSON.stringify({ // guardian: allow
  reading: { discussion: stageInit(phase({}, "discussion")), planning: stageInit(phase({ context: { docs: [{ path: `${FOLDER}/CONTEXT.md`, sha256: "a", bytes: 1 }] } }, "planning")) },
  state: { kept: stateText.startsWith(HAND) && stateOutside === `${HAND}\r\n\r\n`, header: stateText.includes("## Decisions (Lane Pilot)"), refused: "refused" in stateBlockText(`x\n${STATE_BLOCK_START}\n`, {}, { Position: ["a"] }) },
  settings: settingsLayers(),
  spec: specText(phase({ ambiguityGate: true, context: { docs: [], sha: "s", signedAt: 1, requirements: ["R1"], decisions: ["D1", "D2"] }, questions })).split("\n").slice(3, 6),
  uat: { line1: uat.split("\n").filter((line) => line.startsWith("- [")), marked: uatMarked.split("\n").filter((line) => line.startsWith("- [")), state: uatState(uatMarked), missing: markUatLine(uat, 9, true) },
  security: { none: threatGap(risk("Нет")), open: threatGap(risk("token leak")), signed: threatGap(risk("token leak", true)) },
  validation: validationGaps([item("p1", 1, "x", { verification: [{ command: "test -f a.ts" }] }), item("p2", 1, "x")]),
  codebase: { root: docsCompletenessGaps(docs, { tables: [], core: [] }).missingPages, workspace: docsCompletenessGaps(docs, { tables: [], core: [], workspace: true }).missingPages },
  intel: ["NONE\n", `HEAD=${"a".repeat(40)}\nLAST=${"b".repeat(40)}\nBEHIND=5\n`, `HEAD=${"a".repeat(40)}\nLAST=${"a".repeat(40)}\nBEHIND=0\n`].map((probe) => codeFactsState(probe).state),
  backlog: (() => { const b = backlogBoard([todo("small", { estimate: 1 }), todo("no-estimate", { estimate: null }), todo("huge", { estimate: 21 }), todo("waits", { dependsOn: ["open-one"] }), todo("open-one", { status: "open" })]); return { issuable: b.issuable.map((i) => i.id), needsEstimate: b.needsEstimate.map((i) => i.id), decompose: b.decompose.map((i) => i.id), blocked: b.blocked.map((i) => i.id) }; })(),
  spikes: verdictInventory([{ path: ".agents/planning/spikes/a.md", text: "---\nquestion: does WAL help?\nverdict: yes\n---\n" }, { path: ".agents/planning/sketches/b.html", text: "---\ntitle: home\n---\n" }]).map((row) => `${row.kind}:${row.question}:${row.verdict}`),
  profile: parseFragments(JSON.stringify({ fragments: [{ id: "f1", kind: "preference", about_owner: true, confidence: "high" }, { id: "f2", kind: "fact", about_owner: false, confidence: "high" }] }), 2).map((d) => d?.kind ?? null),
  judgeDown: await fragmentJudgeVia(async () => { throw new Error("down"); })(["a"]),
  review: reviewDoc("ph_a1", null, 1, false, { status: "rework", critical_count: 1, findings: [{ file: "src/a.ts", line: 12, title: "save ignored" }] }, "code-critic", clip).split("\n").slice(2, 8),
  lesson,
  graphs: { uiOn: { called: ui.called("review_doc").length, skipped: ui.skipped }, uiOff: { called: uiOff.called("review_doc").length, skipped: uiOff.skipped },
    evalFlawed: out(evalFlawed), aiOk: out(aiOk), aiBlocked: out(aiBlocked) },
  plan: planText(phase({ plan: { items: two } })).split("\n").length, verification: templateFill("VERIFICATION", phase({ plan: { items: two } }), new Map()).split("\n").length,
  roadmap: { next: nextRoadmapRow(markRoadmap("- [ ] 1 A\n- [ ] 2 B\n", "1")), marked: markRoadmap("- [ ] 1 A\n- [ ] 2 B\n", "1").split("\n")[0] },
}));
process.exit(0);
