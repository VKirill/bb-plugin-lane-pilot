// Region 0 (Phase graph), batch b: the plan hand-in, the drawing stage and the start of the execution (n30 … n58, n1768). Every observation runs the REAL
// code of the node (the phase driver on a scratch database and a fake host, the phase logic, the auto stage) and returns plain JSON. The tests of
// tests/sma/four-proofs-r00-b.test.ts assert on it and the scene scripts/lp_drill/scenes/sma_r00_b.py proves the nodes that write no hub row.
// No model, no hub write, nothing outside the machine.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { readFileSync } from "node:fs";
import { sha256Hex } from "@lane-pilot/kit";
import { createCore } from "../../src/rooms/core/server/core";
import { createPhaseDriver } from "../phase-driver";
import {
  contextSignature, designDecision, designGate, nextAction, phaseFolder, planGate, planSignature, wordAsked,
  type Phase, type PhaseRecord, type PlanItem,
} from "../../src/rooms/phase/logic";
import { drawingRequirements } from "../../src/rooms/phase/logic/design";
import { autoDue, autoInputs, createAutoStages } from "../../src/rooms/phase/server/auto-stages";
import { phaseToolParams } from "../../src/rooms/phase/server/tool";
import { designScore, type Measurement } from "../../src/rooms/design-eval/logic";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { createRun, createTask, openDatabase, saveTaskGitBase } from "../../src/rooms/plugin-db";

const DOCS = [{ path: "docs/CONTEXT.md", sha256: sha256Hex("docs/CONTEXT.md"), bytes: 120 }];
export const signed = (): PhaseRecord => ({ context: { docs: DOCS, sha: contextSignature(DOCS), signedAt: 1, risks: { value: "none", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["none"] } });
export const piece = (id: string, wave = 1, extra: Record<string, unknown> = {}, owns?: string[]): PlanItem => ({
  id, title: id, wave, promise: { given: "an empty cell", when: "the sum runs", then: `it skips the cell (${id})` },
  task: { id, owns_paths: owns ?? [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], acceptance: ["works"], ...extra },
});
export const planned = (items: PlanItem[], extra: Partial<PhaseRecord> = {}): PhaseRecord => {
  const record = { ...signed(), ...extra };
  const contextSha = record.context!.sha;
  return { ...record, plan: { items, contextSha, sha: planSignature(items, contextSha), admittedSha: planSignature(items, contextSha), objective: "the goal", premortem: ["r1", "r2", "r3"], critique: { decision: "approve", by: "critic", independence: { ok: true, why: "separate session" } } } };
};
const pure = (record: PhaseRecord, stage: Phase["stage"] = "design"): Phase => ({
  id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sums", goal: "sums are right", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});
const whyOf = (gate: { ok: boolean; why?: string[] }) => (gate.ok ? [] : gate.why ?? []);

export async function host(o: { words?: "on" | "off"; dispatchRun?: string } = {}) {
  const previous = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = o.words ?? "off";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.stop" as never, async () => ({}));
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list" as never, async () => []);
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  if (o.dispatchRun) createRun(db, o.dispatchRun, "projA");
  const files = new Map<string, { sha256: string; sizeBytes: number }>();
  const dispatched: Array<{ task: Record<string, unknown>; plan: string }> = [];
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    runGoal: { check: async () => null },
    workflowEngine: { cancel: () => true, get: () => null, start: () => ({ runId: "wf", done: Promise.resolve() }) },
    dispatchWriter: async (input: { task: Record<string, unknown>; plan?: string }) => { dispatched.push({ task: input.task, plan: input.plan ?? "" }); return { ok: true, taskId: `task-${String(input.task.id)}`, runId: o.dispatchRun ?? "run1" }; },
    readWriterWorkspaceFile: async ({ path }: { path: string }) => files.get(path) ?? { sha256: sha256Hex(path), sizeBytes: 40, content: `# ${path}` },
  } as never).phases;
  const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "sums are right" });
  const restore = () => { if (previous === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = previous; };
  const get = () => getPhase(db, opened.id)!;
  const seed = (stage: Phase["stage"], patch: Partial<PhaseRecord>, extra: { runId?: string } = {}) => savePhase(db, opened.id, { stage, record: { ...get().record, ...patch }, at: 2, ...extra });
  return { bb, db, phases, id: opened.id, files, dispatched, restore, get, seed, path: `${phaseFolder(opened.id)}/design/UI-SPEC.md` };
}
type Host = Awaited<ReturnType<typeof host>>;
const withHost = async <T>(o: Parameters<typeof host>[0], run: (f: Host) => Promise<T>): Promise<T> => { const f = await host(o); try { return await run(f); } finally { f.restore(); } };
const drawingParams = (phaseId: string, extra: Record<string, unknown>): boolean => phaseToolParams.safeParse({ action: "drawing", phaseId, paths: ["a/UI-SPEC.md"], designer: "design-lead", feasible: true, ...extra }).success;
const refusal = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return "not refused"; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } };
const admittedPlan = (items: PlanItem[]) => { const sha = planSignature(items, "ctx"); return { items, sha, admittedSha: sha, contextSha: "ctx" }; };

function seedPlanRun(f: Host, id: string, planSha: string) {
  const nodes = [{ id: "plan", type: "agent", role: "planner" }, { id: "plan_critic", type: "agent", role: "plan-critic" }];
  const createdAt = Date.now() + 60_000;
  f.db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "lp.plan", 1, "sha", JSON.stringify({ id: "lp.plan", nodes }), "projA", "succeeded", JSON.stringify({ plan_sha: planSha }), JSON.stringify({ status: "ok", plan_verdict: "pass" }), createdAt, createdAt);
  ([["plan", "thr_planner", 10, 20], ["plan_critic", "thr_critic", 30, 40]] as const).forEach(([node, thread, started, ended], index) => f.db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, `${node}#${index + 1}`, `${node}#${index + 1}`, node, index + 1, "succeeded", JSON.stringify({ threadId: thread }), started, ended, ended));
}

/** A phase at design with a reviewed, feasible drawing reported by the PM (one file). */
const reportDrawing = (f: Host, over: Partial<{ paths: string[]; designer: string; feasible: boolean; contradiction: string; reviewer: string | undefined }> = {}) =>
  f.phases.drawing({ phaseId: f.id, paths: over.paths ?? [f.path], designer: over.designer ?? "design-lead", feasible: over.feasible ?? true, ...(over.contradiction ? { contradiction: over.contradiction } : {}), ...("reviewer" in over ? (over.reviewer ? { reviewer: over.reviewer } : {}) : { reviewer: "ui-review" }) });

export const observe = {
  /** n30 · a question the plan cannot go on without: stored with its stage, booked, held in the plan gate until answered. */
  async question() {
    return withHost({}, async (f) => {
      f.seed("planning", signed());
      f.phases.question({ phaseId: f.id, text: "Which total?", blocking: true, by: "pm" });
      const both = f.phases.question({ phaseId: f.id, text: "Which colour?", blocking: false, by: "pm" });
      const open = (record: PhaseRecord) => whyOf(planGate({ ...planned([piece("a")]), questions: record.questions })).filter((why) => why.startsWith("open question"));
      const whileOpen = open(both.record);
      const answered = f.phases.answer({ phaseId: f.id, questionId: "q1", answer: "the daily one", by: "owner" });
      return { stored: both.record.questions!.map((q) => [q.id, q.stage, q.blocking, q.text]), whileOpen, afterAnswer: open(answered.record), book: listParts(f.db, f.id).filter((part) => part.kind === "question").map((part) => [part.section, part.text]) };
    });
  },

  /** n31 · the hand-in of a plan: complete is admitted, each missing artifact is named. */
  planHandIn() {
    const items = [piece("a")];
    const edit = (change: (plan: NonNullable<PhaseRecord["plan"]>) => void) => { const record = planned(items); change(record.plan!); return whyOf(planGate(record)); };
    return {
      complete: whyOf(planGate(planned(items))),
      noObjective: edit((plan) => { plan.objective = "  "; }),
      twoRisks: edit((plan) => { plan.premortem = ["r1", "r2"]; }),
      noCheck: edit((plan) => { delete plan.critique; }),
      changes: edit((plan) => { plan.critique = { decision: "changes_requested", by: "critic", summary: "split it" }; }),
    };
  },

  /** n32 · the composition of a plan: the piece's task is the piece, waves come from depends_on, the signature covers the pieces and the context; a goal already met is a plan with no pieces. */
  async planComposition() {
    return withHost({}, async (f) => {
      f.seed("planning", signed());
      const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, owns_paths: [`src/${id}.ts`], verification: [{ command: "npm test" }], acceptance: ["works"], ...extra });
      const out = f.phases.plan({ phaseId: f.id, objective: "the goal", premortem: ["r1", "r2", "r3"], by: "planner", items: [
        { id: "a", title: "a", promise: { given: "g", when: "w", then: "t" }, task: task("zzz") },
        { id: "b", title: "b", promise: { given: "g", when: "w", then: "t" }, task: task("b", { depends_on: ["a"] }) }] });
      const plan = out.record.plan!;
      const second = await host();
      try {
        second.seed("planning", signed());
        const met = second.phases.plan({ phaseId: second.id, items: [], alreadyMet: "the sum already skips blank cells", by: "planner" });
        const record = { ...met.record, plan: { ...met.record.plan!, critique: { decision: "approve" as const, by: "critic", independence: { ok: true, why: "separate session" } } } };
        return { items: plan.items.map((item) => [item.id, item.task.id, item.wave]), shaCoversPiecesAndContext: plan.sha === planSignature(plan.items, plan.contextSha), rounds: plan.rounds, book: listParts(f.db, f.id).filter((part) => part.kind === "submitted").map((part) => part.text.replace(plan.sha.slice(0, 12), "<sha>")),
          notNeeded: { pieces: met.record.plan!.items.length, evidence: met.record.plan!.alreadyMet?.evidence ?? null, gate: whyOf(planGate(record)), book: listParts(second.db, second.id).filter((part) => part.kind === "already_met").length } };
      } finally { second.restore(); }
    });
  },

  /** n34 / n39 · the machine's own start of the drawing: due at design while there is no drawing and no open design question, with the phase as input. */
  drawStart() {
    const items = [piece("ui", 1, {}, ["src/App.tsx"])];
    const base: PhaseRecord = { plan: admittedPlan(items), design: { decision: "needed", why: "pieces that change screens: ui", requirements: ["actions", "screens_states"] }, ...signed() };
    const drawn = { ...base, design: { ...base.design!, drawing: { paths: ["d/UI-SPEC.md"], sha256: "d", designer: "x", reviewer: "y", feasible: true } } };
    const asked = { ...base, questions: [{ id: "q1", stage: "design" as const, text: "Which grid?", blocking: true, askedAt: 1 }] };
    const inputs = autoInputs(pure(base), { kind: "draw" });
    const home = autoInputs(pure(base), { kind: "draw" }, undefined, null, undefined, "/abs/home");
    return { due: autoDue(pure(base)), withDrawing: autoDue(pure(drawn)), openQuestion: autoDue(pure(asked)), atPlanning: autoDue(pure(base, "planning")), paused: autoDue({ ...pure(base), state: "paused" }),
      inputs: { goal: inputs.goal, folder: inputs.folder, requirements: inputs.requirements, material: inputs.material, pieces: inputs.pieces }, homeFolder: home.folder };
  },

  /** n35 / n55 · a plan is admitted by its gate: a screen plan waits for a drawing at design, another goes straight to execution; no drawing before the plan is admitted. */
  async admission() {
    return withHost({}, async (f) => {
      f.seed("planning", signed());
      const folder = `${phaseFolder(f.id)}/design/`;
      f.files.set(`${folder}UI-SPEC.md`, { sha256: "a".repeat(64), sizeBytes: 20 });
      const early = await refusal(() => reportDrawing(f));
      const atPlanning = { refused: early, stage: f.get().stage, parts: listParts(f.db, f.id).filter((part) => part.kind === "drawing").length };
      f.phases.plan({ phaseId: f.id, items: [{ ...piece("ui", 1, {}, ["src/App.tsx"]), wave: undefined } as never], objective: "o", premortem: ["r1", "r2", "r3"], by: "planner" });
      const sha = f.get().record.plan!.sha;
      seedPlanRun(f, "wf_screen", sha);
      const screen = await f.phases.planCheck({ phaseId: f.id, decision: "approve", by: "critic", wfRunId: "wf_screen" });
      const afterAdmit = { stage: screen.stage, admitted: screen.record.plan?.admittedSha === sha, decision: screen.record.design?.decision, why: screen.record.design?.why };
      const drawnTo = await reportDrawing(f);
      const plain = await host();
      try {
        plain.seed("planning", signed());
        plain.phases.plan({ phaseId: plain.id, items: [{ ...piece("a"), wave: undefined } as never], objective: "o", premortem: ["r1", "r2", "r3"], by: "planner" });
        const plainSha = plain.get().record.plan!.sha;
        seedPlanRun(plain, "wf_plain", plainSha);
        const moved = await plain.phases.planCheck({ phaseId: plain.id, decision: "approve", by: "critic", wfRunId: "wf_plain" });
        return { atPlanning, afterAdmit, afterDrawing: drawnTo.stage, plain: { stage: moved.stage, decision: moved.record.design?.decision, why: moved.record.design?.why, admitted: moved.record.plan?.admittedSha === plainSha } };
      } finally { plain.restore(); }
    });
  },

  /** n36 / n37 / n38 · what a drawing must cover and whether one is needed. */
  designDecisions() {
    const ui = (id: string, owns: string[]) => piece(id, 1, {}, owns);
    const brief = (items: PlanItem[], asked?: boolean) => { const d = designDecision(items, asked); return { decision: d.decision, why: d.why, mode: d.mode ?? null, requirements: d.requirements ?? null }; };
    return {
      requirements: { screens: drawingRequirements("screens"), system: drawingRequirements("system"), mixed: drawingRequirements("mixed"), unset: drawingRequirements() },
      logic: brief([ui("a", ["src/a.ts"])]),
      screen: brief([ui("u", ["src/App.tsx"])]),
      folder: brief([ui("p", ["src/components/card.ts"])]),
      style: brief([ui("s", ["web/site.css"])]),
      mixedPlan: brief([ui("scr", ["src/ui/page.tsx"]), ui("sys", ["DESIGN.md"])]),
      asked: brief([ui("a", ["src/a.ts"])], true),
      oneOfTwo: brief([ui("a", ["src/a.ts"]), ui("u", ["src/App.vue"])]),
    };
  },

  /** n40 / n50 · no flag settles the design question for the person: a report does not confirm, a keyed word of the person does. */
  async designWord() {
    return withHost({ words: "on" }, async (f) => {
      f.seed("design", { design: { decision: "needed", why: "screens" } });
      f.files.set(f.path, { sha256: "a".repeat(64), sizeBytes: 20 });
      const reported = await reportDrawing(f);
      const sha = reported.record.design!.drawing!.sha256;
      const noKey = await refusal(() => f.phases.word({ phaseId: f.id, turn: "design", decision: "yes", text: "да", by: "owner via screen" }));
      const wrongKey = await refusal(() => f.phases.word({ phaseId: f.id, turn: "design", decision: "yes", text: "да", by: "owner via screen", key: "f".repeat(64) }));
      const stillWaiting = f.get();
      const said = await f.phases.word({ phaseId: f.id, turn: "design", decision: "yes", text: "да", by: "owner via screen", key: sha });
      const word = said.record.words?.find((row) => row.turn === "design");
      const confirmed = await reportDrawing(f);
      return { accepts: { plain: drawingParams(f.id, {}), confirm: drawingParams(f.id, { confirm: true }), yes: drawingParams(f.id, { yes: true }), owner: drawingParams(f.id, { ownerWord: "yes" }) }, afterReport: { stage: reported.stage, confirmedAt: reported.record.design?.confirmedAt ?? null, gate: whyOf(designGate(reported.record)) }, noKey, wrongKey, waiting: { stage: stillWaiting.stage, words: stillWaiting.record.words?.length ?? 0 },
        word: { decision: word?.decision, key: word?.key === sha, sha: word?.sha === sha, by: word?.by }, afterWord: { stage: confirmed.stage, confirmed: typeof confirmed.record.design?.confirmedAt === "number" },
        book: listParts(f.db, f.id).filter((part) => part.kind === "word_design").map((part) => part.text) };
    });
  },

  /** n41 · a drawing lives in its own folder under the phase: anything else is refused and nothing is recorded. */
  async drawingFolder() {
    return withHost({}, async (f) => {
      f.seed("design", { design: { decision: "needed", why: "screens" } });
      const bad = [`docs/fig.png`, `${phaseFolder(f.id)}/SPEC.md`, `${phaseFolder(f.id)}/design/../SECRET.md`, "/etc/passwd"];
      const refused: Record<string, string> = {};
      for (const path of bad) refused[path.replace(f.id, "<id>")] = (await refusal(() => reportDrawing(f, { paths: [path] }))).replace(f.id, "<id>").split("\n")[0]!;
      const beforeGood = { stage: f.get().stage, drawing: f.get().record.design?.drawing ?? null, parts: listParts(f.db, f.id).filter((part) => part.kind === "drawing").length };
      const moved = await reportDrawing(f, { paths: [`${phaseFolder(f.id)}/design/UI-SPEC.md`, `${phaseFolder(f.id)}/design/kit.html`] });
      return { refused, beforeGood, good: { stage: moved.stage, kept: moved.record.design?.drawing?.paths.map((path) => path.replace(f.id, "<id>")) } };
    });
  },

  /** n42 / n43 / n1768 · the lp.draw stage reports the drawing: the designer draws, another role checks it, the checker's scores are journaled apart from the drawing. */
  async drawStage() {
    const reported: Array<Record<string, unknown>> = [];
    const journaled: Array<Record<string, unknown>> = [];
    const record: PhaseRecord = { design: { decision: "needed", why: "screens" } };
    const make = () => createAutoStages({ log: () => undefined } as never, { workflowEngine: {} as never }, {
      api: { drawing: async (input: Record<string, unknown>) => { reported.push(input); return pure(record); } } as never,
      exhausted: async () => undefined, get: () => pure(record), save: () => undefined, book: () => undefined,
      writeDocs: async () => ({ written: [] }), runtime: () => null, pmIdle: async () => true, now: () => 7,
      journal: async (line: unknown) => { journaled.push(line as Record<string, unknown>); },
    });
    const scores = { hierarchy: 3, spacing: 2, contrast: 3, states: 2 };
    await make().apply(pure(record), { kind: "draw", wfRunId: "wf1", startedAt: 1 }, { verdict: "pass", scores, notes: "ok", paths: ["d/UI-SPEC.md"] } as never);
    const rework = await refusal(() => make().apply(pure(record), { kind: "draw", wfRunId: "wf2", startedAt: 1 }, { verdict: "rework", scores, notes: "redo the states", paths: ["d/UI-SPEC.md"] } as never));
    const call = reported[0] as { designer: string; reviewer: string; feasible: boolean; paths: string[]; critique: unknown };
    const flow = JSON.parse(readFileSync("workflows/lp.draw.json", "utf8")) as { nodes: Array<{ id: string; role?: string }> };
    const gate = designGate({ design: { decision: "needed", why: "screens", drawing: { paths: call.paths, sha256: "d", designer: call.designer, reviewer: call.reviewer, feasible: call.feasible } } });
    const line = journaled[0] as { designer: string; reviewer: string; critique: { scores: unknown; verdict: string; notes: string }; drawingSha: string } | undefined;
    return { calls: reported.length, designer: call.designer, reviewer: call.reviewer, critique: call.critique, gate: whyOf(gate), roles: Object.fromEntries(flow.nodes.filter((node) => node.id === "draw" || node.id === "check").map((node) => [node.id, node.role])),
      rework: { refused: rework.includes("rework"), calls: reported.length, journal: journaled.length, designer: line?.designer, reviewer: line?.reviewer, critique: line?.critique } };
  },

  /** n44 / n46 / n48 / n49 · the readiness of a drawing: each part is named while it is missing; the drawing opens the gate only with all of them. */
  designReadiness() {
    const drawing = { paths: [".agents/phases/ph_1/design/UI-SPEC.md"], sha256: "d".repeat(64), designer: "design-lead", feasible: true, reviewer: "ui-review" };
    const gate = (record: PhaseRecord, spec?: string) => whyOf(designGate(record, spec));
    const needed = (over: Record<string, unknown> = {}, extra: Partial<PhaseRecord> = {}): PhaseRecord => ({ design: { decision: "needed", why: "screens", drawing: { ...drawing, ...over } }, ...extra });
    const noFeas = needed(); delete (noFeas.design!.drawing as { feasible?: boolean }).feasible;
    const noReviewer = needed(); delete (noReviewer.design!.drawing as { reviewer?: string }).reviewer;
    const full = needed({}, { design: { decision: "needed", why: "screens", requirements: ["actions", "accessibility"], drawing } } as never);
    const spec = "## Actions\n## Screens and states";
    const asked = { ...needed(), ownerWords: true } as PhaseRecord;
    const key = (sha: string) => ({ ...asked, words: [{ turn: "design" as const, decision: "yes" as const, by: "owner", text: "да", at: 1, key: sha }] });
    return {
      ready: gate(needed()), none: gate({ design: { decision: "needed", why: "screens" } }), notDecided: gate({}),
      noFeasibility: gate(noFeas), contradicts: gate(needed({ feasible: false, contradiction: "no empty state" })), feasible: gate(needed({ feasible: true })),
      noReviewer: gate(noReviewer), sameRole: gate(needed({ reviewer: "design-lead" })), otherRole: gate(needed({ reviewer: "design-taste" })),
      noContract: gate(needed({ paths: ["d/one.html"] })), missingSection: gate(full, spec), contractFull: gate(full, "## Actions\n## Accessibility"),
      openQuestion: gate(needed({}, { questions: [{ id: "q1", stage: "design", text: "Which grid?", blocking: true, askedAt: 1 }] })), otherStageQuestion: gate(needed({}, { questions: [{ id: "q1", stage: "planning", text: "Which grid?", blocking: true, askedAt: 1 }] })),
      awaitsWord: gate(asked), wordForThisDrawing: gate(key("d".repeat(64))), wordForAnotherDrawing: gate(key("e".repeat(64))), asks: wordAsked(asked, "design"), doesNotAsk: wordAsked(needed(), "design"),
      next: { key: nextAction(pure(asked), new Map()).key, waitsForPm: nextAction(pure(asked), new Map()).waitsForPm },
    };
  },

  /** n45 · the drawing is taken into an edition: a replaced drawing is archived with its hash and the person's earlier yes is voided. */
  async edition() {
    return withHost({ words: "on" }, async (f) => {
      f.seed("design", { design: { decision: "needed", why: "screens" } });
      f.files.set(f.path, { sha256: "a".repeat(64), sizeBytes: 20 });
      const first = await reportDrawing(f);
      const firstSha = first.record.design!.drawing!.sha256;
      await f.phases.word({ phaseId: f.id, turn: "design", decision: "yes", text: "да", by: "owner via screen", key: firstSha });
      const yes = f.get().record.words?.filter((word) => word.turn === "design").length;
      f.files.set(f.path, { sha256: "b".repeat(64), sizeBytes: 21 });
      const second = await reportDrawing(f);
      const record = second.record;
      return { yes, stage: second.stage, redrawn: record.design!.drawing!.sha256 !== firstSha, archived: record.design!.archived?.map((row) => row.sha256 === firstSha), designWords: record.words?.filter((word) => word.turn === "design").length ?? 0,
        asksAgain: whyOf(designGate(record)).some((why) => why.includes("awaits the owner's word")), book: listParts(f.db, f.id).filter((part) => part.kind === "archived").map((part) => part.text.includes(firstSha.slice(0, 12))) };
    });
  },

  /** n47 / n52 · the feasibility answer: «feasible» goes on, a contradiction sends the phase back to planning with its words. */
  async feasibility() {
    return withHost({}, async (f) => {
      f.seed("design", { plan: admittedPlan([piece("ui", 1, {}, ["src/App.tsx"])]), design: { decision: "needed", why: "screens" } });
      const back = await reportDrawing(f, { feasible: false, contradiction: "the screen has no empty state" });
      const parts = listParts(f.db, f.id);
      const gate = whyOf(designGate({ design: { decision: "needed", why: "screens", drawing: { paths: [f.path], sha256: "d", designer: "x", reviewer: "y", feasible: false, contradiction: "no empty state" } } }));
      const nothing = await host();
      try {
        nothing.seed("design", { design: { decision: "needed", why: "screens" } });
        const ok = await reportDrawing(nothing);
        return { back: { stage: back.stage, admittedSha: back.record.plan?.admittedSha ?? null, design: back.record.design ?? null, plan: back.record.plan?.items.length },
          book: parts.filter((part) => part.kind === "drawing" || part.kind === "return").map((part) => [part.kind, part.text.replace(f.id, "<id>")]), gate,
          feasible: { stage: ok.stage, book: listParts(nothing.db, nothing.id).filter((part) => part.kind === "drawing").map((part) => part.text.replace(nothing.id, "<id>")) } };
      } finally { nothing.restore(); }
    });
  },

  /** n51 · a reviewed, feasible drawing is confirmed now (the machine's clock); one that is not reviewed is not. */
  async confirmed() {
    return withHost({}, async (f) => {
      f.seed("design", { design: { decision: "needed", why: "screens" } });
      const unreviewed = await refusal(() => reportDrawing(f, { reviewer: undefined }));
      const held = f.get();
      const before = Date.now();
      const moved = await reportDrawing(f);
      const after = Date.now();
      const at = moved.record.design?.confirmedAt ?? 0;
      return { unreviewed: unreviewed.split("\n")[0], heldStage: held.stage, heldConfirmed: held.record.design?.confirmedAt ?? null, stage: moved.stage, confirmedNow: at >= before && at <= after, reviewer: moved.record.design?.drawing?.reviewer };
    });
  },

  /** n44 · the review time is the machine's own: the journal line is stamped by the driver, and the report carries no time. */
  async reviewTime() {
    return withHost({}, async (f) => {
      f.seed("design", { design: { decision: "needed", why: "screens" } });
      const before = Date.now();
      await reportDrawing(f);
      const after = Date.now();
      const lines = ((await f.bb.storage.kv.get("lp.design.journal")) as Array<{ at: number; reviewer: string | null; designer: string; phaseId: string }> | null) ?? [];
      const line = lines.find((row) => row.phaseId === f.id);
      return { journaled: !!line, reviewer: line?.reviewer ?? null, designer: line?.designer ?? null, machineTime: !!line && line.at >= before && line.at <= after, reportAcceptsATime: ["at", "reviewedAt", "time", "when"].some((key) => drawingParams(f.id, { [key]: 1 })) };
    });
  },

  /** n53 / n54 / n58 · the stage door of the execution: only a phase at execution issues, only its checked edition, each piece as its own work, a piece after the pieces it depends on. */
  async execution() {
    return withHost({}, async (f) => {
      const a = piece("a", 1), b = piece("b", 2, { depends_on: ["a"] });
      const run = async (stage: Phase["stage"], patch: Partial<PhaseRecord>) => { f.seed(stage, patch); const before = f.dispatched.length; const out = await f.phases.drive(f.get()); return { stage: out.stage, dispatched: f.dispatched.length - before, issued: Object.keys(out.record.execution?.issued ?? {}) }; };
      const needsDrawing = { plan: admittedPlan([a]), design: { decision: "needed" as const, why: "screens" } };
      const atDesign = await run("design", needsDrawing);
      const atPlanning = await run("planning", { plan: admittedPlan([a]) });
      const items = [a, b];
      f.seed("execution", { plan: admittedPlan(items), execution: { issued: {}, startedAt: 1 } });
      const first = await f.phases.drive(f.get());
      const firstTasks = f.dispatched.map((row) => String(row.task.id));
      const parts = listParts(f.db, f.id).filter((part) => part.kind === "issued").map((part) => part.text);
      const task = f.dispatched[0]!;
      const edited = await host();
      try {
        const changed = piece("a", 1); changed.promise = { ...changed.promise, then: "something else" };
        edited.seed("execution", { plan: { items: [changed], sha: planSignature([changed], "ctx"), admittedSha: "e".repeat(64), contextSha: "ctx" }, execution: { issued: {}, startedAt: 1 } });
        const refused = await refusal(() => edited.phases.drive(edited.get()));
        return { api: { hasIssue: "issue" in f.phases }, atDesign, atPlanning, first: { stage: first.stage, issued: first.record.execution!.issued, tasks: firstTasks, ownTaskId: task.task.id, plan: task.plan.split("\n")[0], quality: task.task.quality_mode }, book: parts,
          edited: { refused: refused.split("\n")[0], dispatched: edited.dispatched.length, issued: edited.get().record.execution?.issued ?? null } };
      } finally { edited.restore(); }
    });
  },

  /** n55 · the drawing is ready or not needed before the execution: the gate opens for «not needed» and for a ready drawing only. */
  designDoor() {
    const drawing = { paths: [".agents/phases/ph_1/design/UI-SPEC.md"], sha256: "d", designer: "design-lead", feasible: true, reviewer: "ui-review" };
    const gate = (record: PhaseRecord) => whyOf(designGate(record));
    return { notNeeded: gate({ design: { decision: "not_needed", why: "no piece changes a screen" } }), needed: gate({ design: { decision: "needed", why: "screens" } }), ready: gate({ design: { decision: "needed", why: "screens", drawing } }),
      unreviewed: gate({ design: { decision: "needed", why: "screens", drawing: { ...drawing, reviewer: undefined } } }), undecided: gate({}) };
  },

  /** n56 / n57 · the base of the phase is fixed at the first issue and stays; the row carries the address (run), the edition, the drawing and the base. */
  async phaseRow() {
    return withHost({ dispatchRun: "run9" }, async (f) => {
      const a = piece("a", 1), b = piece("b", 1);
      for (const [id, sha] of [["task-a", "1".repeat(40)], ["task-b", "2".repeat(40)]] as const) {
        createTask(f.db, { id, runId: "run9", kind: "bb", contract: a.task });
        saveTaskGitBase(f.db, id, { baseRef: "main", baseSha: sha, initialHeadSha: sha, branch: "main", compareCommitted: true });
      }
      const drawing = { paths: [f.path], sha256: "d".repeat(64), designer: "design-lead", reviewer: "ui-review", feasible: true };
      f.seed("execution", { plan: admittedPlan([a, b]), design: { decision: "needed", why: "screens", drawing, confirmedAt: 3 }, execution: { issued: {}, startedAt: 1 } });
      const edition = f.get().edition;
      const first = await f.phases.drive(f.get());
      const base = first.record.execution?.baseSha;
      f.db.prepare("UPDATE lane_pilot_task_git_base SET base_sha=? WHERE task_id='task-a'").run("3".repeat(40));
      const again = await f.phases.drive(f.get());
      const row = f.db.prepare("SELECT id, run_id, stage, edition FROM lane_pilot_phase WHERE id=?").get(f.id) as { id: string; run_id: string; stage: string; edition: number };
      return { base, baseAfterAnotherPass: again.record.execution?.baseSha, firstPieceBase: base === "1".repeat(40),
        row: { id: row.id === f.id, runId: row.run_id, stage: row.stage, editionGrew: row.edition > edition, issued: again.record.execution?.issued, startedAt: typeof again.record.execution?.startedAt, drawing: again.record.design?.drawing?.paths.map((path) => path.replace(f.id, "<id>")) } };
    });
  },

  /** n1768 · a page is scored by the rubric, criterion by criterion and width by width: the score is the mean of every criterion at every width. */
  rubric() {
    const clean: Measurement = { width: 1280, overflowPx: 0, textElements: 40, lowContrast: 0, targets: 6, smallTargets: 0, tinyText: 0, h1: 1, spacingValues: 8 };
    const phone: Measurement = { ...clean, width: 375, overflowPx: 5 };
    const one = designScore([phone]);
    const two = designScore([phone, clean]);
    return { oneWidth: { score: one.score, criteria: one.byWidth[0]!.criteria.map((c) => [c.id, c.score]) }, twoWidths: two.score, clean: designScore([clean]).score, none: designScore([]).score };
  },
};
