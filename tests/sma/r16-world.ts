// Region 16 (slash commands and workflows), batch a: the scratch world the node tests and the scene probe share. Each `observe.<smaId>()` runs the
// REAL code of the node on a scratch database, a fake host whose file store is a map, or the real workflow engine with fake executors, and
// returns plain data. No vitest import: scenes/sma_r16_probe.ts loads this file under vite-node. No model, no hub, nothing outside the machine.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import {
  designGate, issuable, nextAction, pieceSha, planSignature, wavesOf, piecesOfWave,
  type GateResult, type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";
import {
  ANIMATOR_LAW, DRAWING_RULES, archiveDrawing, designMode, motionRows, piecePlan, rubricLine, stageInit, uiContractGap, waveTable,
} from "../../src/rooms/phase/stages";
import { designDecision } from "../../src/rooms/phase/logic/design";
import { presenceHold } from "../../src/rooms/owner-presence/logic";
import type { StepContext } from "@lane-pilot/workflow-engine";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase, savePrototypeConfig, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { createWriterReassign, takeReassignRequest } from "../../src/rooms/writer/server/reassign";
import { previousAttemptBrief } from "../../src/rooms/writer/server/writer-task";
import { runSim } from "../workflow/chain-harness";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";

export const PH = "ph_sma";
export const D = `.agents/phases/${PH}/design`;
export const phase = (record: PhaseRecord, stage: Phase["stage"] = "planning", over: Partial<Phase> = {}): Phase => ({
  id: PH, projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0, ...over,
});
export const item = (id: string, over: Partial<PlanItem> = {}): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: `then-${id}` },
  task: { id, project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: [`acc-${id}`] }, ...over,
});
export const uiItem = (id: string, over: Partial<PlanItem> = {}): PlanItem => item(id, { task: { ...item(id).task, owns_paths: ["src/app.tsx"], qa_cases: [{ name: "c" }], qa_url: "http://x" }, ...over });
export const dep = (id: string, wave: number, ...after: string[]): PlanItem => item(id, { wave, task: { ...item(id).task, depends_on: after } });
export const fact = (taskId: string, over: Partial<TaskFact> = {}): TaskFact => ({ taskId, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", browserQa: "passed", qaPlanned: true, ...over });
const ids = (items: readonly PlanItem[]) => items.map((row) => row.id);
const why = (check: GateResult): string[] => (check.ok ? [] : check.why);
const OFF = { branch: "phase/test", trees: {}, off: "no phase branch in this test" };

// ---------------------------------------------------------------- the phase driver on a fake host
export function phaseWorld() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
  harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const texts = new Map<string, string>();
  const commits: Array<{ paths: string[]; message: string }> = [];
  const commands: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    if (method === "writePhaseBook") {
      const edits = input.edits as Array<{ path: string; content: string; expectedSha256: string | null }>;
      return { status: "applied", writes: edits.map((edit) => { texts.set(edit.path, edit.content); return { path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) }; }) };
    }
    if (method === "gitCommitDocs") { commits.push({ paths: input.paths as string[], message: String(input.message) }); return { commit: "c".repeat(40) }; }
    if (method === "runCommand") { commands.push(String(input.command)); return { exitCode: 0, stdout: `${"a".repeat(64)}\n`, stderr: "" }; }
    if (method === "readBoundedFile") return { path: input.relativePath, content: texts.get(String(input.relativePath)) ?? "file body", truncated: false };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', writer_workspace_path='/repo', pm_thread_id='t' WHERE id='run1'").run();
  const services = {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => { if (!texts.has(i.path)) throw new Error("no file"); const c = texts.get(i.path)!; return { content: c, sha256: sha256Hex(c), sizeBytes: c.length }; },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { sent.push(input.task); createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task as never }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  return { phases, db, texts, commits, commands, sent };
}
export type World = ReturnType<typeof phaseWorld>;

const SPEC = "# spec\n## Actions\n## Screens\n## Texts\n## Heuristics\n## Accessibility\n";
const planRec = (items: PlanItem[], over: Record<string, unknown> = {}) => ({ items, contextSha: "ctx", sha: planSignature(items, "ctx"), critique: { decision: "approve", by: "c", independence: { ok: true, why: "" } }, objective: "o", premortem: ["a", "b", "c"], ...over });

async function opened(w: World, record: Record<string, unknown>, stage: Phase["stage"]) {
  const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  savePhase(w.db, made.id, { stage, state: "active", runId: "run1", record: { ...made.record, ...record } as never, at: 2 });
  return made.id;
}

/** A phase at design with a drawn UI piece: the drawing reported the way a PM's specialist reports it and the way the lp.draw auto stage reports it. */
async function drawnBy(designer: string, reviewer: string) {
  const w = phaseWorld();
  const items = [uiItem("p1")];
  const id = await opened(w, { plan: planRec(items, { admittedSha: planSignature(items, "ctx") }), design: { decision: "needed", why: "x" } }, "design");
  const paths = [`.agents/phases/${id}/design/UI-SPEC.md`, `.agents/phases/${id}/design/kit.png`];
  w.texts.set(paths[0]!, SPEC);
  w.texts.set(paths[1]!, "png");
  const done = await w.phases.drawing({ phaseId: id, paths, designer, feasible: true, reviewer });
  const live = getPhase(w.db, id)!;
  return { stage: done.stage, kept: live.record.design?.drawing?.paths.map((path) => path.split("/").at(-1)), committed: w.commits.map((c) => c.paths.map((path) => path.split("/").at(-1))),
    commit: live.record.design?.drawing?.commit?.slice(0, 7) ?? null, designer: live.record.design?.drawing?.designer, book: listParts(w.db, id).filter((p) => p.section === "design").map((p) => p.kind) };
}

const waitsWord = (plan: PlanItem[]) => phase({ ownerWords: true, context: { docs: [], sha: "ctx", signedAt: 1, legacy: true }, plan: planRec(plan) as never,
  design: { decision: "needed", why: "screens", drawing: { paths: [`${D}/UI-SPEC.md`], sha256: "s1", designer: "design-lead", feasible: true, reviewer: "ui-review" } } } as never, "design");

export const observe = {
  /** n1144: only a person confirms — the gate holds the drawing for the owner's word, a yes for THIS drawing settles it, a redraw asks again. */
  async k_c_design() {
    const drawing = { paths: [`${D}/UI-SPEC.md`], sha256: "s1", designer: "design-lead", feasible: true, reviewer: "ui-review" };
    const rec = (words?: unknown[]) => ({ ownerWords: true, design: { decision: "needed", why: "", drawing }, ...(words ? { words } : {}) }) as unknown as PhaseRecord;
    const yes = (key: string) => ({ turn: "design", decision: "yes", text: "ok", by: "owner", at: 1, key });
    const head = (check: GateResult) => why(check).map((line) => line.split(":")[0]);
    return { held: head(designGate(rec())), confirmed: designGate(rec([yes("s1")])).ok, redrawn: head(designGate(rec([yes("old")]))) };
  },

  /** n1145: the waves — a piece is issued once the pieces it depends on are accepted; the driver issues wave 1 and waits. */
  async k_c_execute() {
    const a = item("p1"), b = dep("p2", 2, "p1"), c = item("p3");
    const none = issuable([a, b, c], {}, new Map());
    const after = issuable([a, b, c], { p1: "t1", p3: "t3" }, new Map([["p1", fact("t1")]]), { p1: pieceSha(a), p3: pieceSha(c) });
    const w = phaseWorld();
    const items = [item("q1"), dep("q2", 2, "q1")];
    const id = await opened(w, { candidate: OFF, plan: planRec(items, { admittedSha: planSignature(items, "ctx") }) }, "execution");
    await w.phases.drive(getPhase(w.db, id)!);
    const live = getPhase(w.db, id)!;
    return { first: ids(none), afterP1: ids(after), sent: w.sent.map((task) => String(task.id)), issued: Object.keys(live.record.execution?.issued ?? {}) };
  },

  /** n1146: lp.build runs a batch of tasks and ends done, partial or blocked. */
  async k_c_execplan() {
    const tasks = [{ id: "t1", depends_on: [] }, { id: "t2", depends_on: ["t1"] }, { id: "t3", depends_on: [] }];
    const accept = (ctx: { input: { item?: unknown } }) => ({ state: "accepted", merge_commit: `c-${(ctx.input.item as { id: string }).id}` });
    const failT3 = (ctx: { input: { item?: unknown } }) => ((ctx.input.item as { id: string }).id === "t3" ? { state: "failed" } : accept(ctx));
    const run = async (stubs: Record<string, unknown>) => { const r = await runSim("lp.build", { input: { tasks }, stubs: stubs as never }); return { path: r.path.join(" "), out: r.summary.output as Record<string, unknown> }; };
    const done = await run({ run_tasks: accept, gate: { ok: true } });
    const partial = await run({ run_tasks: failT3, gate: { ok: true } });
    const blocked = await run({ run_tasks: { state: "blocked" } });
    const pick = (r: { out: Record<string, unknown> }) => ({ status: r.out.status, accepted: r.out.accepted_ids, failed: r.out.failed_ids, commits: r.out.merged_commits });
    return { done: { path: done.path, ...pick(done) }, partial: { path: partial.path, ...pick(partial) }, blocked: { path: blocked.path, ...pick(blocked) } };
  },

  /** n1147: a task that fails its done-criteria goes back to the writer with the failing check, its exit code and the way to fix it. */
  k_c_noderepair() {
    const last = { status: "validation_failed", reason: "verification failed (npm test): boom", checkName: "npm test", verification: [{ command: "npm test", exitCode: 1, stdout: "", stderr: "AssertionError: expected 2 to be 3" }] };
    const brief = previousAttemptBrief(last, { owns_paths: ["src/**"] });
    return { briefLine: brief.split("\n").find((line) => line.includes("the check")) ?? "", accepted: previousAttemptBrief({ status: "accepted" }), none: previousAttemptBrief(null) };
  },

  /** n1148 / n1163: a stage's rubric — the order of work and what blocks it. */
  k_wd_rubric() { return { design: rubricLine("design"), closed: rubricLine("closed") }; },
  k_we_rubric() { return { execution: rubricLine("execution") }; },

  /** n1149: what the drawer reads before drawing. */
  k_wd_read() {
    const rec = { context: { docs: [{ path: `.agents/phases/${PH}/CONTEXT.md`, sha256: "x" }], sha: "ctx", signedAt: 1 } } as unknown as PhaseRecord;
    return { design: stageInit({ id: PH, stage: "design", record: rec }), noDocs: stageInit({ id: PH, stage: "design", record: {} as PhaseRecord }) };
  },

  /** n1150: the mode from the files the pieces touch. */
  k_wd_mode() {
    const own = (id: string, ...paths: string[]) => item(id, { task: { ...item(id).task, owns_paths: paths } });
    const screens = designDecision([own("a", "src/pages/home.tsx")]);
    const system = designDecision([own("a", "src/theme/palette.css")]);
    const mixed = designDecision([own("a", "src/theme/palette.css"), own("b", "src/app.tsx")]);
    return { screens: [designMode([own("a", "src/pages/home.tsx")]), screens.requirements], system: [designMode([own("a", "src/theme/palette.css")]), system.requirements],
      mixed: [designMode([own("a", "DESIGN.md"), own("b", "src/app.vue")]), mixed.requirements], none: designMode([]) };
  },

  /** n1151: the previous contract to the archive. */
  k_wd_version() {
    const drawing = (sha: string) => ({ paths: [`${D}/a.html`], sha256: sha, designer: "d", feasible: true, reviewer: "r" });
    const rec = (prev: string, archived: number) => ({ design: { decision: "needed", why: "", drawing: drawing(prev), archived: Array.from({ length: archived }, (_, i) => drawing(`old${i}`)) } }) as unknown as PhaseRecord;
    return { replaced: archiveDrawing(rec("a", 0), drawing("b")).map((row) => row.sha256), same: archiveDrawing(rec("a", 0), drawing("a")).length, first: archiveDrawing({} as PhaseRecord, drawing("a")).length,
      capped: archiveDrawing(rec("a", 10), drawing("b")).map((row) => row.sha256) };
  },

  /** n1152 / n1160: both paths — the PM's specialist and the lp.draw auto stage — make the same artifacts and end at the same gate. */
  async k_wd_path() { return { pm: await drawnBy("design-lead", "ui-review"), auto: await drawnBy("lp.draw: specialist design-lead", "lp.draw: plan-critic") }; },

  /** n1153: the drawing rules reach the draw and the check steps of lp.draw. */
  async k_wd_h1() {
    const prompts = new Map<string, string>();
    await runSim("lp.draw", { input: { goal: "g", pieces: "p1", folder: "f" }, stubs: { agent: ((ctx: { nodeId: string; node: { prompt?: string } }) => { prompts.set(ctx.nodeId, String(ctx.node.prompt)); return { paths: ["f/design/UI-SPEC.md"], feasible: true, verdict: "pass" }; }) as never } });
    const words = ["data-theme", "--<variant>.html", "page-prototype", "no build step", "150–300 ms", "hierarchy, spacing, contrast, states, brand, motion"];
    const has = (node: string) => ({ rules: prompts.get(node)?.includes(DRAWING_RULES) ?? false, words: words.filter((word) => prompts.get(node)?.includes(word)) });
    return { draw: has("draw"), check: has("check"), words, rulesHave: words.filter((word) => DRAWING_RULES.includes(word)) };
  },

  /** n1154 / n1170: the contract of checkable points. */
  k_wd_h2() {
    const drawing = (...paths: string[]) => ({ paths, sha256: "s", designer: "d", feasible: true, reviewer: "r" });
    const rec = (...paths: string[]) => ({ design: { decision: "needed", why: "", drawing: drawing(...paths), requirements: ["actions", "screens_states", "texts", "heuristics", "accessibility"] } }) as unknown as PhaseRecord;
    const full = "# Spec\n## Actions\n## Screens\n## Texts\n## Heuristics\n## Accessibility\n";
    return { noContract: uiContractGap(rec(`${D}/kit.png`)), designMd: uiContractGap(rec("DESIGN.md", `${D}/kit.png`)), partial: uiContractGap(rec(`${D}/UI-SPEC.md`), "# Spec\n## Actions\n## Screens\n"), full: uiContractGap(rec(`${D}/UI-SPEC.md`), full),
      notNeeded: uiContractGap({ design: { decision: "not_needed", why: "" } } as unknown as PhaseRecord) };
  },
  k_we_contract() {
    const w = observe.k_wd_h2();
    const rec = phase({ design: { decision: "needed", why: "", drawing: { paths: [`${D}/UI-SPEC.md`], sha256: "s", designer: "d", feasible: true, reviewer: "r" } } } as never, "execution");
    const screen = piecePlan(rec, uiItem("p1")), backend = piecePlan(rec, item("p2"));
    return { noContract: w.noContract, execution: stageInit(rec), screen: screen.split("\n").find((line) => line.includes("the screens follow")) ?? "", backend: backend.includes("phase drawing") };
  },

  /** n1155 / n1162: the independent check and the readiness answer. */
  k_wd_h3() {
    const rec = (over: Record<string, unknown>) => ({ design: { decision: "needed", why: "", drawing: { paths: [`${D}/UI-SPEC.md`], sha256: "s", designer: "design-lead", feasible: true, ...over } } }) as unknown as PhaseRecord;
    return { none: why(designGate(rec({}))), same: why(designGate(rec({ reviewer: "design-lead" }))), other: designGate(rec({ reviewer: "ui-review" })).ok };
  },
  k_wd_c3() {
    const rec = (over: Record<string, unknown>, paths = [`${D}/UI-SPEC.md`]) => ({ design: { decision: "needed", why: "", drawing: { paths, sha256: "s", designer: "design-lead", ...over } } }) as unknown as PhaseRecord;
    return { noPaths: why(designGate(rec({ feasible: true, reviewer: "ui-review" }, []))), noAnswer: why(designGate(rec({ reviewer: "ui-review" }))), contradicts: why(designGate(rec({ feasible: false, contradiction: "needs a backend", reviewer: "ui-review" }))),
      noContract: why(designGate(rec({ feasible: true, reviewer: "ui-review" }, [`${D}/kit.png`]))), ready: designGate(rec({ feasible: true, reviewer: "ui-review" })).ok };
  },

  /** n1156: the sketch is opened in a browser at the viewports, the verdict comes out of that check. */
  async k_wd_snapshot() {
    const input = { run_id: "lprun_1", task_id: "t1", url: "http://127.0.0.1:5173/", cases: ["Open home"], env_class: "local" };
    let given: Record<string, unknown> = {};
    const qa = (ctx: StepContext) => { given = ctx.inputs as Record<string, unknown>; return { state: "failed", reply: { reason: "case 1 failed" } }; };
    const r = await runSim("lp.browser-qa", { input, stubs: { qa: qa as never, verdict: { state: "failed" } } });
    return { path: r.path.join(" "), qa: { url: given.url, viewports: given.viewports, cases: given.cases, authorized: given.authorized }, out: r.summary.output };
  },

  /** n1157: the material step runs only where phase.draw_material is on, and hands its path to the drawing. */
  async k_wd_i1() {
    const stubs = { material: { material_path: "f/design/MATERIAL.md" }, draw: { paths: ["f/design/UI-SPEC.md"], feasible: true }, check: { verdict: "pass" } };
    const off = await runSim("lp.draw", { input: { goal: "g", pieces: "p1", folder: "f" }, stubs });
    const on = await runSim("lp.draw", { input: { goal: "g", pieces: "p1", folder: "f", material: true }, stubs });
    const ran = (r: Awaited<ReturnType<typeof runSim>>) => r.steps.filter((s) => s.state === "succeeded").map((s) => s.node_id);
    return { off: ran(off), offSkipped: off.skipped, offDraw: (off.called("draw")[0]!.input as Record<string, unknown>).material_path, on: ran(on), onDraw: (on.called("draw")[0]!.input as Record<string, unknown>).material_path, onCheck: (on.called("check")[0]!.input as Record<string, unknown>).material_path };
  },

  /** n1158: the designer draws — Lane Pilot draws the screens itself, the PM is told not to start another designer. */
  k_wd_i2() {
    const bare = phase({ design: { decision: "needed", why: "screens", motion: ["p1"] } } as never, "design", { id: "ph_x" });
    const drawn = phase({ design: { decision: "needed", why: "screens", mode: "screens", drawing: { paths: [`.agents/phases/ph_x/design/UI-SPEC.md`], sha256: "s", designer: "d", feasible: true } } } as never, "design", { id: "ph_x" });
    const a = nextAction(bare, new Map()), b = nextAction(drawn, new Map());
    return { bare: { waitsForPm: a.waitsForPm, text: a.text.slice(0, 180), motion: a.text.includes(`Motion rows p1: ${ANIMATOR_LAW}`) }, drawn: { text: b.text.split("\n")[1]?.slice(0, 60) ?? "", mentionsLpDraw: b.text.includes("lp.draw draws") } };
  },

  /** n1159: the check before the gate — a «rework» verdict sends the drawing back to the designer, a pass goes on. */
  async k_wd_i3() {
    const r = await runSim("lp.draw", { input: { goal: "g", pieces: "p1", folder: "f" }, stubs: { draw: { paths: ["f/design/UI-SPEC.md"], feasible: true }, check: [{ verdict: "rework", notes: "no empty state" }, { verdict: "pass" }] } });
    return { path: r.steps.filter((s) => s.state === "succeeded").map((s) => s.node_id), draws: r.called("draw").length, checks: r.called("check").length };
  },

  /** n1161: the contract awaits confirmation — recorded as such, and the phase says who it waits for. */
  k_wd_c2() {
    const wait = nextAction(waitsWord([item("p1")]), new Map());
    const said = phase({ ...waitsWord([item("p1")]).record, words: [{ turn: "design", decision: "yes", text: "ok", by: "owner", at: 1, key: "s1" }] } as never, "design");
    const after = nextAction(said, new Map());
    return { wait: { key: wait.key, waitsForPm: wait.waitsForPm, text: wait.text.slice(0, 60) }, after: { key: after.key.slice(0, 11), waitsForPm: after.waitsForPm } };
  },

  /** n1164: the execution context in one call. */
  k_we_init() {
    const rec = { design: { decision: "needed", why: "", drawing: { paths: [`${D}/UI-SPEC.md`, `${D}/kit.png`], sha256: "s", designer: "d", feasible: true } }, context: { docs: [{ path: "c.md", sha256: "x" }], sha: "c", signedAt: 1 } } as unknown as PhaseRecord;
    return { execution: stageInit({ id: PH, stage: "execution", record: rec }), plain: stageInit({ id: PH, stage: "execution", record: {} as PhaseRecord }),
      verification: stageInit({ id: PH, stage: "verification", record: rec }), discussion: stageInit({ id: PH, stage: "discussion", record: rec }) };
  },

  /** n1165: a piece already issued (its work is in the tree) is not issued again on a resume. */
  k_we_resume() {
    const a = item("p1"), b = dep("p2", 2, "p1");
    const issued = { p1: "t1" }, same = { p1: pieceSha(a) };
    const resumed = issuable([a, b], issued, new Map([["p1", fact("t1")]]), same);
    const stillRunning = issuable([a, b], issued, new Map([["p1", fact("t1", { state: "running" })]]), same);
    const changed = issuable([{ ...a, promise: { ...a.promise, then: "something else" } }, b], issued, new Map([["p1", fact("t1")]]), same);
    return { resumed: ids(resumed), stillRunning: ids(stillRunning), changed: ids(changed) };
  },

  /** n1166: is anybody at the keyboard — a writer keeps off a provider the owner used in the last ten minutes. */
  k_we_headless() {
    const presence = [{ providerId: "codex", at: 1_000_000, hostId: "h1", host: "mac" }, { providerId: "claude-code", at: 1_000_000 - 3_600_000, hostId: "h1", host: null }];
    return { within: presenceHold("codex", presence, 1_000_000 + 2 * 60_000), edge: presenceHold("codex", presence, 1_000_000 + 10 * 60_000), after: presenceHold("codex", presence, 1_000_000 + 11 * 60_000),
      old: presenceHold("claude-code", presence, 1_000_000), other: presenceHold("opencode", presence, 1_000_000), wide: presenceHold("codex", presence, 1_000_000 + 20 * 60_000, 30 * 60_000) };
  },

  /** n1167: the marker branch of a closed phase — phase/<id>, or milestone/<slug> of the roadmap section the row sits under. */
  async k_we_branch() {
    const run = async (branch: "phase" | "milestone") => {
      const w = phaseWorld();
      const id = await opened(w, { branch, roadmapRow: "1.1" }, "closed");
      savePhase(w.db, id, { record: { ...getPhase(w.db, id)!.record, bookWritten: { seq: 0, sha256: "", at: 1 } }, at: Date.now() });
      w.texts.set(".agents/planning/ROADMAP.md", "# Map\n\n## Milestone v1\n\n- [ ] 1.1 Hud — build it\n");
      await w.phases.tick();
      return { command: w.commands.find((line) => line.startsWith("git branch")) ?? "", book: listParts(w.db, id).filter((p) => p.kind === "branch").map((p) => p.text), id };
    };
    const milestone = await run("milestone"), phaseBranch = await run("phase");
    return { milestone: [milestone.command, milestone.book], phase: [phaseBranch.command.replace(phaseBranch.id, "<id>"), phaseBranch.book.map((text) => text.replace(phaseBranch.id, "<id>"))] };
  },

  /** n1168: the plan inventory with its waves in one query. */
  k_we_discover() {
    const items = [item("b", { wave: 2 }), item("a", { wave: 1 }), item("c", { wave: 2 }), item("d", { wave: 1 })];
    return { waves: wavesOf(items), perWave: wavesOf(items).map((wave) => ids(piecesOfWave(items, wave))), ready: ids(issuable(items, {}, new Map())) };
  },

  /** n1169: the computed wave table goes into the execution journal as the wave's first pieces are issued. */
  async k_we_wavetable() {
    const items = [item("p1"), item("p2", { promise: { given: "g", when: "w", then: "a | b" } }), dep("p3", 2, "p1")];
    const table = waveTable(1, piecesOfWave(items, 1), { p1: "task_1" });
    const w = phaseWorld();
    const id = await opened(w, { candidate: OFF, plan: planRec(items, { admittedSha: planSignature(items, "ctx") }) }, "execution");
    await w.phases.drive(getPhase(w.db, id)!);
    return { table: table.split("\n"), journal: listParts(w.db, id).filter((p) => p.kind === "wave_table").map((p) => p.text.split("\n")) };
  },

  /** n1171: motion rows get the animator's rules. */
  k_we_animator() {
    const slide = item("m", { promise: { given: "g", when: "w", then: "the card slides in with a transition" } });
    const ru = item("r", { promise: { given: "g", when: "w", then: "карточка появляется с анимацией" } });
    const plain = item("t", { promise: { given: "g", when: "w", then: "fix the typo in the footer" } });
    const noted = item("n", { title: "the unanimated list", promise: { given: "g", when: "w", then: "rows are counted" } });
    const decision = designDecision([uiItem("m", { promise: slide.promise }), plain]);
    return { rows: motionRows([slide, ru, plain, noted]), decision: decision.motion };
  },

  /** n1172: the animator's law inline in a piece's plan, for a run without subagents (phase.piece_notes). */
  k_we_animator_inline() {
    const motion = item("m", { promise: { given: "g", when: "w", then: "the card fades in with a 200 ms transition" } });
    const line = (text: string) => text.split("\n").find((row) => row.startsWith("Motion (")) ?? null;
    return { on: line(piecePlan(phase({ pieceNotes: true }), motion)), onPlain: line(piecePlan(phase({ pieceNotes: true }), item("t"))), off: line(piecePlan(phase({}), motion)) };
  },

  /** n1173: delegate a running plan to another AI — the PM names a provider and a model, the old writer stops, the next one is told. */
  async k_we_crossai() {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const stops: string[] = [];
    harness.sdk.stub("threads.stop", async (args: { threadId: string }) => { stops.push(args.threadId); return {}; });
    const db = openDatabase(bb);
    const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: "/ws", writerWorkspacePath: "/ws", pmProviderId: "p", pmModel: "pm", writerProviderId: "claude-code", writerModel: "sonnet" };
    createRun(db, "run1", "proj1", "bb", "/ws");
    setRunThread(db, "run1", "thr_pm");
    savePrototypeConfig(db, config);
    const contract = { schema_version: 2, id: "T1", title: "T1", risk: "low", lane: "writer", project_cwd: "/ws", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["T1/a.txt"], owns_paths: ["T1/**"], never_touch: [], depends_on: [],
      objective: "Make T1", acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: "/ws" }] } as unknown as TaskV2;
    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract });
    createAttempt(db, { id: "T1-a1", runId: "run1", taskId: "T1" });
    transitionAttempt(db, "T1-a1", "spawn_requested");
    transitionAttempt(db, "T1-a1", "running", { threadId: "thr_w" });
    const reassign = createWriterReassign({ bb, db } as never, { timeoutMs: 10, sleep: async () => undefined });
    const named = await reassign.requestReassign({ projectId: "proj1", runId: "run1", taskId: "T1", providerId: "codex", model: "gpt-x", reason: "let codex do this one" });
    const request = await takeReassignRequest(bb.storage.kv as never, "T1-a1");
    const state = (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='T1-a1'").get() as { state: string }).state;
    return { named, request, stops, state };
  },
};
