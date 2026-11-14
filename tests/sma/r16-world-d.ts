// Region 16 (slash commands and workflows), batch d: quick work, navigation and session commands, phase planning (n1237 … n1267).
// The scratch world the node tests and the scene probe (scripts/lp_drill/scenes/sma_r16_d_probe.ts) share. Each `observeD.<smaId>()` runs the REAL code of the node
// (the real workflow engine with fake executors on the real graph files, the phase driver on a scratch database and a fake host, the PM tool, the phase gates) and returns
// plain data. No vitest import: the probe loads this file under vite-node. No model, no hub, nothing outside the machine. Batch a's and b's observations are in
// r16-world.ts and r16-world-b.ts (not edited here).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { nextAction, planGate, planSignature, type Phase, type PhaseRecord, type PlanItem } from "../../src/rooms/phase/logic";
import { STAGE_RUBRICS, openQuestions, quickRow, stageInit, threatGap, uiContractGap } from "../../src/rooms/phase/stages";
import { getPhase, savePhase } from "../../src/rooms/phase/store";
import { registerPhaseTool, phaseToolParams } from "../../src/rooms/phase/server/tool";
import { registeredTools } from "../../src/rooms/platform/server";
import { createRun, createTask, openDatabase } from "../../src/rooms/plugin-db";
import { bundledAgentDefinitions } from "../../src/rooms/relay/server/handoff";
import { canonicalSkillName } from "../../src/rooms/contracts/helper-context";
import { cliCommands, cliUsageText } from "../../src/rooms/tools/server/cli-commands";
import { applyQualityMode } from "../../src/rooms/contracts/quality-mode";
import { taskHomeAbs, taskHomeOwner, taskHomeRel } from "../../src/rooms/storage/task-manifest";
import { findOutOfScopeProjectLifeWrites, foldCoveredTaskIds, parseProjectLifeFinalMessage, projectLifePrompt, shouldTriggerProjectLife } from "../../src/rooms/project-life/project-life";
import { codeMapDrift, sessionStartText } from "../../src/rooms/session-hooks/logic";
import { runSim } from "../workflow/chain-harness";
import { item, phase, PH } from "./r16-world";

export const PLAN_OK = { status: "ok", clear: true, task_count: 1, risk: "low", already_met: false, objective: "o", tasks: [], waves: [], task: { id: "t1", goal: "g" } };
export const WRITE_OK = { state: "accepted", merged_commits: ["abc"] };
const REVIEW_OK = { critical_count: 0, high_count: 0, findings: [] as unknown[] };
const STATE_OK = { ok: true, note: "", comment: "done" };
const quickStubs = { plan: PLAN_OK, write: WRITE_OK, "write-medium": WRITE_OK, "write-full": WRITE_OK, "lp.review": REVIEW_OK, state: STATE_OK, validate: { verdict: "ok", notes: "" }, research: { notes: "files a.ts" } };
type Row = Record<string, unknown>;
const quick = (input: Row, stubs: Row = {}, humans?: Record<string, Row>) => runSim("issue-quick", { input: { title: "t", text: "x", ...input }, stubs: { ...quickStubs, ...stubs } as never, ...(humans ? { humans } : {}) });
const pathOf = (r: Awaited<ReturnType<typeof runSim>>) => r.path.join(" ");
const outOf = (r: Awaited<ReturnType<typeof runSim>>) => r.summary.output as Row;
const wfJson = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "workflows", `${name}.json`), "utf8")) as { inputs: Record<string, { default?: unknown }>; nodes: Array<Row & { id: string }> };
const nodeOf = (name: string, id: string) => wfJson(name).nodes.find((row) => row.id === id)!;

// ---------------------------------------------------------------- the phase driver on a fake host, and the PM tool registered over it
function phaseWorldD() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
  harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const texts = new Map<string, string>();
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    if (method === "writePhaseBook") {
      const edits = input.edits as Array<{ path: string; content: string }>;
      return { status: "applied", writes: edits.map((edit) => { texts.set(edit.path, edit.content); return { path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) }; }) };
    }
    if (method === "gitCommitDocs") return { commit: "c".repeat(40) };
    if (method === "runCommand") return { exitCode: 0, stdout: `${"a".repeat(64)}\n`, stderr: "" };
    if (method === "readBoundedFile") return { path: input.relativePath, content: texts.get(String(input.relativePath)) ?? "file body", truncated: false };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', writer_workspace_path='/repo', pm_thread_id='thr_pm' WHERE id='run1'").run();
  const services = {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => { if (!texts.has(i.path)) throw new Error("no file"); const c = texts.get(i.path)!; return { content: c, sha256: sha256Hex(c), sizeBytes: c.length }; },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task as never }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services;
  const ctx = createCore(bb, db);
  const phases = createPhaseDriver(ctx, services).phases;
  registerPhaseTool(ctx, { phases } as never);
  const tool = registeredTools(bb.agents).get("lane_pilot_phase")!;
  const call = async (args: Record<string, unknown>) => JSON.parse(String(await tool.execute(phaseToolParams.parse(args), { threadId: "thr_pm", projectId: "projA", signal: new AbortController().signal } as never))) as Row;
  return { phases, db, texts, call };
}

const ctxReady = () => ({ docs: [], sha: "ctx", signedAt: 1, legacy: true });
const planRec = (items: PlanItem[], over: Record<string, unknown> = {}) => ({ items, contextSha: "ctx", sha: planSignature(items, "ctx"), critique: { decision: "approve", by: "c", independence: { ok: true, why: "" } }, objective: "o", premortem: ["a", "b", "c"], ...over });
const why = (record: PhaseRecord): string[] => { const check = planGate(record); return check.ok ? [] : check.why; };

const ranLp = (r: Awaited<ReturnType<typeof runSim>>) => r.path.filter((id) => !r.skipped.includes(id));
const TASKS = (...ids: string[]) => ids.map((id) => ({ id, objective: id, depends_on: [] }));

export const observeD = {
  // ---- quick work
  async k_c_next() {
    const w = phaseWorldD();
    const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
    const first = await w.call({ action: "next", phaseId: made.id });
    await w.phases.setState({ phaseId: made.id, state: "pause", by: "owner" });
    const paused = await w.call({ action: "next", phaseId: made.id });
    return { id: made.id, first: { stage: first.stage, waitsForYou: first.waitsForYou, next: String(first.next).split("\n")[0]!.slice(0, 60), hasHead: typeof first.bookHead }, paused: { stage: paused.stage, waitsForYou: paused.waitsForYou, next: paused.next } };
  },
  async k_wq_init() {
    const wf = wfJson("issue-quick");
    const flags = Object.fromEntries(["full", "validate", "discuss", "research"].map((flag) => [flag, wf.inputs[flag]?.default]));
    return {
      flags,
      none: pathOf(await quick({})),
      validate: pathOf(await quick({ validate: true })),
      full: pathOf(await quick({ full: true })),
      research: pathOf(await quick({ research: true })),
      discuss: pathOf(await quick({ discuss: true }, {}, { discuss: { answer: "the label", answer_kind: "answered" } })),
    };
  },
  k_wq_dir() {
    return { home: taskHomeRel("quick-1"), dotted: taskHomeRel("a.b_c-1"), empty: taskHomeRel(""), slash: taskHomeRel("a/b"), up: taskHomeRel(".."), space: taskHomeRel("a b"), long: taskHomeRel("x".repeat(129)),
      abs: taskHomeAbs("/repo/", "quick-1"), absBad: taskHomeAbs("/repo", "../x"), owner: taskHomeOwner(".agents/tasks/quick-1/PLAN.md"), ownerOther: taskHomeOwner(".agents/plans/items/quick-1/PLAN.md") };
  },
  async k_wq_discuss() {
    const on = await quick({ discuss: true }, {}, { discuss: { answer: "the label", answer_kind: "answered" } });
    const off = await quick({});
    return { on: pathOf(on), asked: on.called("discuss").length, planAfter: pathOf(on).split(" ").indexOf("plan") > pathOf(on).split(" ").indexOf("discuss"), off: pathOf(off), offAsked: off.called("discuss").length, humanRole: nodeOf("issue-quick", "discuss").role, humanType: nodeOf("issue-quick", "discuss").type };
  },
  async k_wq_research() {
    const on = await quick({ research: true });
    const off = await quick({});
    return { on: pathOf(on), planSaw: on.called("plan")[0]!.input, off: pathOf(off), offPlanSaw: off.called("plan")[0]!.input, role: nodeOf("issue-quick", "research").role };
  },
  async k_wq_plan() {
    const route = async (plan: Row) => { const r = await quick({}, { plan: { ...PLAN_OK, ...plan } }); return { path: pathOf(r), status: outOf(r).status, comment: outOf(r).comment }; };
    return {
      one: await route({}),
      notClear: await route({ clear: false }),
      two: await route({ task_count: 2 }),
      high: await route({ risk: "high" }),
      met: await route({ already_met: true, task_count: 0 }),
      failed: await route({ status: "failed" }),
    };
  },
  async k_wq_check() {
    const verdicts = (...v: Array<"ok" | "rework">) => v.map((verdict) => ({ verdict, notes: `n-${verdict}` }));
    const ok = await quick({ validate: true });
    const once = await quick({ validate: true }, { validate: verdicts("rework", "ok") });
    const twice = await quick({ validate: true }, { validate: verdicts("rework", "rework") });
    const full = await quick({ full: true });
    const none = await quick({});
    return { ok: pathOf(ok), once: pathOf(once), twice: pathOf(twice), validations: twice.called("validate").length, plans: twice.called("plan").length, full: pathOf(full), none: pathOf(none), role: nodeOf("issue-quick", "validate").role };
  },
  async k_wq_exec() {
    const wf = wfJson("issue-quick");
    const modes = Object.fromEntries(["write", "write-medium", "write-full"].map((id) => [id, nodeOf("issue-quick", id).quality_mode]));
    const low = await quick({});
    const medium = await quick({}, { plan: { ...PLAN_OK, risk: "medium" } });
    const full = await quick({ full: true });
    const lost = await quick({}, { write: { state: "failed", merged_commits: [] } });
    const lintFail = await quick({}, { "lp.lint_contract": { ok: false } });
    return { modes, low: pathOf(low), lowOut: outOf(low), medium: pathOf(medium), full: pathOf(full), lost: [pathOf(lost), outOf(lost).status, outOf(lost).comment], lintFail: [pathOf(lintFail), outOf(lintFail).status], inputsKnown: Object.keys(wf.inputs).includes("full") };
  },
  async k_wq_review() {
    const stubs = { "lp.review": { critical_count: 0, high_count: 1, findings: [{ severity: "high", file: "a.ts:3" }] } };
    const validate = await quick({ validate: true }, stubs);
    const full = await quick({ full: true }, stubs);
    const plain = await quick({}, stubs);
    const o = outOf(validate);
    return { validate: [pathOf(validate), o.status, (o.review_findings as unknown[]).length], full: [pathOf(full), outOf(full).status, (outOf(full).review_findings as unknown[]).length], plain: [pathOf(plain), plain.called("lp.review").length], policy: (nodeOf("issue-quick", "review").join as Row).policy };
  },
  async k_wq_verify() {
    const validate = await quick({ validate: true });
    const full = await quick({ full: true });
    const plain = await quick({});
    const medium = await quick({ validate: true }, { plan: { ...PLAN_OK, risk: "medium" } });
    return {
      validate: [pathOf(validate), validate.called("lp.review").length, outOf(validate).comment],
      full: [pathOf(full), full.called("lp.review").length],
      plain: [pathOf(plain), plain.called("lp.review").length, outOf(plain).comment],
      medium: pathOf(medium),
      modes: { quick: applyQualityMode({ "plan_critique.enabled": true, "code_critique.enabled": true }, "quick"), full: applyQualityMode({}, "full"), standard: applyQualityMode({ a: 1 }, "standard") },
    };
  },
  k_wq_state() {
    const first = quickRow("---\nphase: \"a\"\n---\n# State\n", { date: "2026-11-10", task: "fix typo", commit: "abc123" })!;
    const second = quickRow(first, { date: "2026-11-11", task: "fix icon", commit: "def456" })!;
    return {
      table: first.includes("| date | task | commit |\n| --- | --- | --- |\n| 2026-11-10 | fix typo | abc123 |\n"), headings: second.match(/## Quick Tasks Completed/g)!.length,
      rows: second.split("\n").filter((line) => line.startsWith("| 2026")), none: quickRow(null, { date: "d", task: "t", commit: "c" }), unnamed: quickRow("# State\n", { date: "d", task: "", commit: "c" })!.includes("| d | quick task | c |"),
    };
  },
  // ---- navigation and session
  k_c_help() {
    const lines = cliUsageText.split("\n");
    const named = cliCommands.map((command) => ({ name: command.name, lines: lines.filter((line) => new RegExp(`^bb lane-pilot ${command.name}(\\s|$)`).test(line)).length }));
    const bare = lines.filter((line) => /^bb lane-pilot regress(\s|$)/.test(line));
    return { commands: cliCommands.length, missing: named.filter((row) => row.lines === 0).map((row) => row.name), repeated: named.filter((row) => row.lines > 1).map((row) => row.name), regressLine: bare, firstLine: lines[0]!.slice(0, 40) };
  },
  k_c_progress() {
    const files = [".agents/PROGRESS.md", ".agents/CHANGELOG.md", ".agents/plans/ROADMAP.md", ".agents/todos/INDEX.md", "./.agents/PROGRESS.md"];
    const bad = ["src/app.ts", ".agents/LESSONS.md", "docs/ARCHITECTURE.md", ".agents/decisions/d1.md", ".agents/PROGRESS.md.bak"];
    const prompt = projectLifePrompt({ workspace: "/repo", runId: "run_1", artifactDirs: ["a/"], taskFolders: [".agents/tasks/t1/"], tasks: [{ id: "t1", title: "Fix hud" } as never], nowIso: "2026-11-14T10:00:00Z" });
    return {
      inScope: findOutOfScopeProjectLifeWrites(files), outOfScope: findOutOfScopeProjectLifeWrites([...files, ...bad]),
      final: parseProjectLifeFinalMessage(`noise\n{"status":"updated","commit":"${"a".repeat(40)}","files":[".agents/PROGRESS.md"]}`),
      noChange: parseProjectLifeFinalMessage('{"status":"no_change","commit":null,"files":[]}'),
      idle: shouldTriggerProjectLife(["run_2"], "run_1"), busy: shouldTriggerProjectLife(["run_1", "run_2"], "run_1"),
      folded: foldCoveredTaskIds(["b", "a", "b", "c"], ["c"]),
      sections: ["Now", "Blocked", "Next", "Last verify", "Pointers"].every((section) => prompt.includes(section)), tasksData: prompt.includes('"id":"t1"'),
    };
  },
  k_c_resume() {
    const pm = bundledAgentDefinitions().find((agent) => agent.id === "dev-orchestrator")!;
    return { skills: pm.skills, hasResume: pm.skills?.includes("project-resume"), alias: canonicalSkillName("resume-project"), canonical: canonicalSkillName("project-resume"), other: canonicalSkillName("lp-docs") };
  },
  async k_c_pause() {
    const w = phaseWorldD();
    const items = [item("p1"), item("p2")];
    const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
    const sha = planSignature(items, "ctx");
    savePhase(w.db, made.id, { stage: "execution", state: "active", runId: "run1", record: { ...made.record, context: ctxReady(), plan: planRec(items, { admittedSha: sha }), execution: { issued: { p1: "p1" } } } as never, at: 2 });
    await w.phases.setState({ phaseId: made.id, state: "pause", by: "owner" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const dir = `.agents/phases/${made.id}`;
    const handoff = JSON.parse(w.texts.get(`${dir}/HANDOFF.json`) ?? "null") as Row | null;
    const note = w.texts.get(`${dir}/PAUSE.md`) ?? null;
    return {
      id: made.id, files: [...w.texts.keys()].filter((path) => path.startsWith(dir)).sort(),
      handoff: handoff && { stage: handoff.stage, state: handoff.state, goal: handoff.goal, pieces: handoff.pieces, openQuestions: handoff.openQuestions, awaitingOwnerWord: handoff.awaitingOwnerWord, candidate: handoff.candidate, resume: handoff.resume, nextKey: (handoff.nextAction as Row).key },
      note: note && { title: note.split("\n")[0], stage: note.split("\n")[2], pieces: note.split("\n").find((line) => line.startsWith("Кусочки плана")), how: note.split("\n").find((line) => line.startsWith("Как продолжить")) },
    };
  },
  // ---- phase planning
  k_c_plan() {
    const items = [item("p1")];
    const base = { context: ctxReady(), plan: planRec(items) } as unknown as PhaseRecord;
    const plan = (over: Record<string, unknown>) => ({ ...base, plan: planRec(items, over) }) as unknown as PhaseRecord;
    return {
      approved: why(base), none: why({ context: ctxReady() } as PhaseRecord)[0],
      noCheck: why(plan({ critique: undefined })), changes: why(plan({ critique: { decision: "changes_requested", by: "c", summary: "split p1" } })),
      notIndependent: why(plan({ critique: { decision: "approve", by: "c", independence: { ok: false, why: "same thread" } } })),
      rounds2: why(plan({ rounds: 2, critique: { decision: "changes_requested", by: "c" } })),
      rounds3: why(plan({ rounds: 3, critique: { decision: "changes_requested", by: "c" } })),
      rounds3ok: why(plan({ rounds: 3 })),
      onOtherContext: why({ ...base, context: { ...ctxReady(), sha: "other" } } as unknown as PhaseRecord),
      noObjective: why(plan({ objective: " " })), twoRisks: why(plan({ premortem: ["a", "b"] })),
    };
  },
  async k_c_converge() {
    const r = (decision: string, over: Row = {}) => runSim("plan-review-convergence", { input: { phase_id: "ph_1" }, stubs: { critic_a: { decision: "approve", findings: [] }, critic_b: { decision: "approve", findings: [] }, converge: { decision, findings: [{ severity: "high", text: "split p1" }], rounds: 2, ...over } } });
    const approved = await r("approve");
    const changes = await r("changes_requested");
    return { approved: [pathOf(approved), outOf(approved)], changes: [pathOf(changes), outOf(changes)] };
  },
  async k_c_review() {
    const r = await runSim("plan-review-convergence", { input: { phase_id: "ph_1" }, stubs: { critic_a: { decision: "approve", findings: [{ text: "a" }] }, critic_b: { decision: "changes_requested", findings: [{ text: "b" }] }, converge: { decision: "changes_requested", findings: [{ text: "a" }, { text: "b" }], rounds: 1 } } });
    const wf = wfJson("plan-review-convergence");
    const node = (id: string) => wf.nodes.find((row) => row.id === id)!;
    return { path: pathOf(r), ran: [r.called("critic_a").length, r.called("critic_b").length, r.called("converge").length], roles: [node("critic_a").role, node("critic_b").role, node("converge").role], consumes: (node("converge").consumes as Array<{ from: string }>).map((c) => c.from), out: outOf(r) };
  },
  async k_wp_rubric() {
    const w = phaseWorldD();
    const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
    const byStage = await w.call({ action: "rubric", stage: "planning" });
    savePhase(w.db, made.id, { stage: "planning", at: 2 });
    const byPhase = await w.call({ action: "rubric", phaseId: made.id });
    return { byStage, sameByPhase: JSON.stringify(byPhase) === JSON.stringify(byStage), counts: [STAGE_RUBRICS.planning.order.length, STAGE_RUBRICS.planning.antipatterns.length] };
  },
  k_wp_init() {
    const rec = { context: { docs: [{ path: ".agents/phases/ph_sma/CONTEXT.md", sha256: "x" }, { path: ".agents/phases/ph_sma/SECURITY.md", sha256: "y" }] } } as unknown as PhaseRecord;
    const at = (stage: Phase["stage"]) => stageInit({ id: PH, stage, record: rec });
    return { discussion: at("discussion"), planning: at("planning"), closed: at("closed"), noDocs: stageInit({ id: PH, stage: "planning", record: {} as PhaseRecord }) };
  },
  async k_wp_closed() {
    const w = phaseWorldD();
    const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
    savePhase(w.db, made.id, { stage: "closed", state: "closed", at: 3 });
    const refuse = async (run: () => unknown) => { try { await run(); return "no refusal"; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } };
    const resumed = await refuse(() => w.phases.setState({ phaseId: made.id, state: "resume" }));
    const paused = await refuse(() => w.phases.setState({ phaseId: made.id, state: "pause" }));
    const replanned = await refuse(() => w.phases.returnTo({ phaseId: made.id, to: "planning", note: "again" }));
    // Each half of the closed test alone: a phase at the closed stage that still says active, and an active stage that says closed.
    const onlyStage = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud S", goal: "s" });
    savePhase(w.db, onlyStage.id, { stage: "closed", state: "active", at: 4 });
    const onlyState = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud T", goal: "t" });
    savePhase(w.db, onlyState.id, { stage: "execution", state: "closed", at: 4 });
    const stageOnly = await refuse(() => w.phases.setState({ phaseId: onlyStage.id, state: "resume" }));
    const stateOnly = await refuse(() => w.phases.setState({ phaseId: onlyState.id, state: "pause" }));
    const open = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud 2", goal: "more hud" });
    return { id: made.id, stageOnly: stageOnly.replace(onlyStage.id, made.id), stateOnly: stateOnly.replace(onlyState.id, made.id), resumed, paused, replanned, stage: getPhase(w.db, made.id)!.stage, state: getPhase(w.db, made.id)!.state, newPhase: open.id !== made.id && open.stage === "discussion" };
  },
  k_wp_headless() {
    const q = (id: string, over: Row = {}) => ({ id, stage: "planning", text: `text ${id}`, blocking: true, ...over });
    const record = { context: ctxReady(), plan: planRec([item("p1")]), questions: [q("q1"), q("q2", { blocking: false }), q("q3", { stage: "discussion" }), q("q4", { answer: "yes" })] } as unknown as PhaseRecord;
    const answered = { ...record, questions: (record.questions ?? []).map((question) => question.id === "q1" ? { ...question, answer: "go on" } : question) } as PhaseRecord;
    const asked = nextAction(phase(record, "planning"), new Map());
    return {
      held: openQuestions(record, "planning").map((question) => question.id), heldAfterAnswer: openQuestions(answered, "planning").map((question) => question.id),
      gate: why(record), gateAfter: why(answered),
      next: { waitsForPm: asked.waitsForPm, key: asked.key, text: asked.text.slice(0, 120) },
      nextAfter: nextAction(phase(answered, "planning"), new Map()).key.startsWith("planning:questions"),
    };
  },
  k_wp_context() {
    const rec = { context: { docs: [{ path: ".agents/phases/ph_sma/CONTEXT.md", sha256: "x" }, { path: ".agents/phases/ph_sma/DISCUSSION.md", sha256: "y" }] } } as unknown as PhaseRecord;
    const planning = stageInit({ id: PH, stage: "planning", record: rec });
    return { planning, firstTwo: planning.slice(0, 2), spec: planning.indexOf(`.agents/phases/${PH}/SPEC.md`), rubricFirst: STAGE_RUBRICS.planning.order[0] };
  },
  async k_wp_research() {
    const stubs = { plan: { tasks: TASKS("a", "b", "c"), task_count: 3 }, plan_critic: { status: "pass" } };
    const off = await runSim("lp.plan", { input: { goal: "g" }, stubs });
    const on = await runSim("lp.plan", { input: { goal: "g", skip_research: false }, stubs: { ...stubs, research: { research_md: "R" } } });
    const quickMode = await runSim("lp.plan", { input: { goal: "g", skip_research: false }, mode: "quick", stubs: { plan: stubs.plan } });
    return { off: ranLp(off), on: ranLp(on), planSaw: on.called("plan")[0]!.input, quick: ranLp(quickMode), offResearch: off.called("research").length };
  },
  async k_wp_validation() {
    const stubs = { plan: { tasks: TASKS("a", "b", "c"), task_count: 3 }, plan_critic: { status: "pass" } };
    const off = await runSim("lp.plan", { input: { goal: "g" }, stubs });
    const on = await runSim("lp.plan", { input: { goal: "g", validation: true }, stubs: { ...stubs, strategy: { validation_md: "V" } } });
    const quickMode = await runSim("lp.plan", { input: { goal: "g", validation: true }, mode: "quick", stubs: { plan: stubs.plan } });
    return { off: ranLp(off), on: ranLp(on), planSaw: on.called("plan")[0]!.input, emitted: outOf(on).validation_md, quick: ranLp(quickMode), role: nodeOf("lp.plan", "strategy").role };
  },
  k_wp_threat() {
    const rec = (security: string | undefined, docs: string[]) => ({ context: { docs: docs.map((path) => ({ path, sha256: "x" })), sha: "ctx", signedAt: 1, ...(security === undefined ? {} : { risks: { security } }) } }) as unknown as PhaseRecord;
    return {
      none: threatGap(rec("none", [])), nope: threatGap(rec("No.", [])), nothing: threatGap(rec("nothing special", [])), unset: threatGap(rec(undefined, [])), blank: threatGap(rec("  ", [])),
      risk: threatGap(rec("user tokens leave the box", [".agents/phases/ph_sma/CONTEXT.md"])), withModel: threatGap(rec("user tokens leave the box", [".agents/phases/ph_sma/SECURITY.md"])),
      inGate: why({ ...rec("user tokens leave the box", []), plan: planRec([item("p1")]) } as unknown as PhaseRecord).filter((line) => line.includes("threat model")),
    };
  },
  k_wp_uigate() {
    const rec = (decision: "needed" | "not_needed", paths: string[], requirements?: string[]) => ({ design: { decision, why: "w", ...(paths.length ? { drawing: { paths, sha256: "s" } } : {}), ...(requirements ? { requirements } : {}) } }) as unknown as PhaseRecord;
    return {
      noContract: uiContractGap(rec("needed", ["kit.png"])), withSpec: uiContractGap(rec("needed", ["UI-SPEC.md", "kit.png"])), withDesign: uiContractGap(rec("needed", ["DESIGN.md"])),
      notNeeded: uiContractGap(rec("not_needed", ["kit.png"])), noDrawing: uiContractGap(rec("needed", [])),
      missingSection: uiContractGap(rec("needed", ["UI-SPEC.md"], ["screens_states", "texts"]), "# UI\n\n## Screens and states\n"),
    };
  },
  k_wp_drift() {
    return { behind: codeMapDrift("aaa", "bbb", 3), same: codeMapDrift("aaa", "aaa", 3), fresh: codeMapDrift("aaa", "bbb", 0), noMeta: codeMapDrift(null, "bbb", 3), noHead: codeMapDrift("aaa", undefined, 3), fraction: codeMapDrift("aaa", "bbb", 2.9), negative: codeMapDrift("aaa", "bbb", -1), text: sessionStartText({ codeMapBehind: 3 }), none: sessionStartText({ codeMapBehind: 0 }) };
  },
  async k_wp_patterns() {
    const stubs = { plan: { tasks: TASKS("a", "b", "c"), task_count: 3 }, plan_critic: { status: "pass" } };
    const off = await runSim("lp.plan", { input: { goal: "g" }, stubs });
    const on = await runSim("lp.plan", { input: { goal: "g", patterns: true }, stubs: { ...stubs, patterns: { patterns_md: "P" } } });
    const quickMode = await runSim("lp.plan", { input: { goal: "g", patterns: true }, mode: "quick", stubs: { plan: stubs.plan } });
    return { off: ranLp(off), on: ranLp(on), planSaw: on.called("plan")[0]!.input, emitted: outOf(on).patterns_md, quick: ranLp(quickMode) };
  },
  async k_wp_planner() {
    const wf = wfJson("lp.plan");
    const lintFail = (errors: string[]) => ({ ok: false, errors, waves: [] as string[][] });
    const bad = await runSim("lp.plan", { input: { goal: "g" }, stubs: { plan: { tasks: TASKS("a"), task_count: 1 }, "lp.lint_contract": lintFail(["a: owns_paths overlap"]) } });
    const fixed = await runSim("lp.plan", { input: { goal: "g" }, stubs: { plan: { tasks: TASKS("a"), task_count: 1 }, "lp.lint_contract": [lintFail(["a: owns_paths overlap"]), { ok: true, errors: [], waves: [["a"]] }] } });
    const gaps = await runSim("lp.plan", { input: { goal: "g", mode: "gaps", gaps: "g1" }, stubs: { plan: { tasks: TASKS("a"), task_count: 1 } } });
    const already = await runSim("lp.plan", { input: { goal: "g" }, stubs: { plan: { tasks: [], task_count: 0, already_met: true } } });
    const big = await runSim("lp.plan", { input: { goal: "g" }, stubs: { plan: { tasks: TASKS("a", "b", "c"), task_count: 3, waves: [["a"], ["b", "c"]] }, plan_critic: { status: "pass" } } });
    return {
      role: nodeOf("lp.plan", "plan").role, maxVisits: (nodeOf("lp.plan", "plan").guards as Row).maxVisits, modeInput: wf.inputs.mode?.default,
      bad: [ranLp(bad), bad.called("plan").length, bad.called("lp.lint_contract").length, outOf(bad).status],
      fixed: [ranLp(fixed), fixed.called("plan").map((call) => call.input), outOf(fixed).status],
      gaps: [ranLp(gaps), gaps.called("plan")[0]!.input, outOf(gaps).status],
      already: [ranLp(already), outOf(already).already_met, outOf(already).task_count],
      big: [ranLp(big), outOf(big).task_count, outOf(big).plan_verdict],
    };
  },
};
