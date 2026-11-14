// Region 0 (Phase graph), batch a: the discussion and the plan admission cards (n0 … n29). The scratch world the node tests and the scene probe share. Each
// `observe.<smaId>()` runs the REAL code of the node (the phase driver on a scratch database and a fake host whose file store is a map, the phase gates,
// the next-action text, the real workflow engine with fake executors on the real graph files) and returns plain data. No vitest import: the probe
// scenes/sma_r00_a_probe.ts loads this file under vite-node. No model, no hub, nothing outside the machine.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import {
  RISK_KINDS, checkerIndependence, contextSignature, discussionGate, nextAction, pieceProblems, planGate, planSignature, waveProblems, withComputedWaves,
  type GateResult, type JournalStep, type Phase, type PhaseRecord, type PlanItem,
} from "../../src/rooms/phase/logic";
import { contextDoc } from "../../src/rooms/phase/server/auto-stages";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { createRun, openDatabase } from "../../src/rooms/plugin-db";
import { runSim } from "../workflow/chain-harness";

const why = (check: GateResult): string[] => (check.ok ? [] : check.why);
export const RISKS = { value: "none", usability: "none", feasibility: "none", viability: "none" };
const CARD = { risks: RISKS, appetite: "one day", noGos: ["no new screens"] };

export const piece = (id: string, wave = 1, task: Record<string, unknown> = {}): PlanItem => ({
  id, title: id, wave, promise: { given: "an empty cell", when: "the sum runs", then: "it skips the cell" },
  task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], acceptance: ["works"], ...task },
});
const signedRecord = (over: Partial<NonNullable<PhaseRecord["context"]>> = {}): PhaseRecord => {
  const docs = [{ path: "docs/CONTEXT.md", sha256: "a".repeat(64), bytes: 80 }];
  return { context: { docs, sha: contextSignature(docs), signedAt: 1, risks: { ...RISKS, value: "missed totals" }, appetite: "one day", noGos: ["none"], ...over } };
};
export const plannedRecord = (items: PlanItem[], plan: Record<string, unknown> = {}): PhaseRecord => {
  const record = signedRecord();
  const contextSha = record.context!.sha;
  return { ...record, plan: { items, contextSha, sha: planSignature(items, contextSha), objective: "the goal", premortem: ["r1", "r2", "r3"], critique: { decision: "approve", by: "plan-critic", independence: { ok: true, why: "checker thr_c started after planner thr_p" } }, ...plan } as never };
};
const phaseAt = (record: PhaseRecord, stage: Phase["stage"] = "discussion"): Phase => ({
  id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sums", goal: "sums are right", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});

// ---------------------------------------------------------------- the phase driver on a fake host
type Engine = { start: (input: { workflow: { id: string } }) => unknown; get: (runId: string) => unknown };
export function world(ownerWords: "on" | "off" = "off", engine?: Engine) {
  const previous = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = ownerWords;
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  for (const method of ["threads.stop", "threads.send"]) harness.sdk.stub(method as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle", environmentId: "env_pm" }));
  harness.sdk.stub("environments.get" as never, async () => ({ path: "/repo", hostId: "h" }));
  harness.sdk.stub("threads.list" as never, async () => []);
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const texts = new Map<string, string>();
  const writes: Array<{ path: string; expectedSha256: string | null; status: string }> = [];
  const commits: Array<{ paths: string[]; message: string }> = [];
  (bb.hosts as { experimental_client: unknown }).experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    if (method === "writePhaseBook") {
      const edits = input.edits as Array<{ path: string; content: string; expectedSha256: string | null }>;
      // The host applies an edit only over the bytes the caller read: a write that names another hash is a conflict, nothing is written.
      return { status: "applied", writes: edits.map((edit) => {
        const onDisk = texts.get(edit.path);
        const expected = onDisk === undefined ? null : sha256Hex(onDisk);
        const status = edit.expectedSha256 === expected ? "applied" : "conflict";
        writes.push({ path: edit.path, expectedSha256: edit.expectedSha256, status });
        if (status === "applied") texts.set(edit.path, edit.content);
        return { path: edit.path, status, afterSha256: status === "applied" ? sha256Hex(edit.content) : undefined, beforeSha256: expected ?? undefined };
      }) };
    }
    if (method === "gitCommitDocs") { commits.push({ paths: input.paths as string[], message: String(input.message) }); return { commit: "c".repeat(40) }; }
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', writer_workspace_path='/repo', pm_thread_id='thr_pm' WHERE id='run1'").run();
  const services = {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => { if (!texts.has(i.path)) throw new Error("no such file"); const c = texts.get(i.path)!; return { content: c, sha256: sha256Hex(c), sizeBytes: Buffer.byteLength(c) }; },
    dispatchWriter: async () => ({ taskId: "task-new", runId: "run1" }),
    ...(engine ? { workflowEngine: engine } : {}),
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  const restore = () => { if (previous === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = previous; };
  /** The files the card names, there and not empty. */
  const seed = (...paths: string[]) => { for (const path of paths) texts.set(path, `# ${path}\nwritten by the PM`); };
  return { db, phases, texts, writes, commits, restore, seed };
}
type World = ReturnType<typeof world>;
const openPhase = (w: World, title = "Sums", goal = "skip blanks") => w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title, goal });
const DOCS = ["docs/CONTEXT.md", "docs/FAQ.md", "docs/ADR.md"];
const partsOf = (w: World, id: string, kind: string) => listParts(w.db, id).filter((part) => part.kind === kind);

/** The journal of a lp.plan run, the way the engine writes it: one row per step with its thread and times (steps: node, role, thread, started, ended). */
function seedPlanRun(w: World, id: string, steps: Array<[string, string, string, number, number]>, planSha: string, extra: { output?: Record<string, unknown>; createdAt?: number } = {}) {
  const nodes = [{ id: "plan", type: "agent", role: "planner" }, { id: "plan_critic", type: "agent", role: "plan-critic" }];
  const createdAt = extra.createdAt ?? Date.now() + 60_000;
  w.db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "lp.plan", 1, "sha", JSON.stringify({ id: "lp.plan", nodes }), "projA", "succeeded", JSON.stringify({ plan_sha: planSha }), JSON.stringify(extra.output ?? { status: "ok", plan_verdict: "pass" }), createdAt, createdAt);
  steps.forEach(([node, , thread, started, ended], index) => w.db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, `${node}#${index + 1}`, `${node}#${index + 1}`, node, index + 1, "succeeded", JSON.stringify({ threadId: thread }), started, ended, ended));
}

/** A phase at planning with a submitted plan (one piece) on a signed context whose document is on disk. */
async function planningWorld(ownerWords: "on" | "off" = "off") {
  const w = world(ownerWords);
  w.seed(DOCS[0]!);
  const made = await openPhase(w);
  await w.phases.context({ phaseId: made.id, docs: [DOCS[0]!], ...CARD });
  if (ownerWords === "on") await w.phases.word({ phaseId: made.id, turn: "context", decision: "yes", text: "да", by: "owner via screen" });
  w.phases.plan({ phaseId: made.id, items: [piece("a")], objective: "the goal", premortem: ["r1", "r2", "r3"], by: "planner" });
  return { w, id: made.id, planSha: getPhase(w.db, made.id)!.record.plan!.sha };
}
const refusal = async (run: Promise<unknown>): Promise<{ message: string; why: string[] } | null> => {
  try { await run; return null; } catch (cause) { return { message: cause instanceof Error ? cause.message : String(cause), why: (cause as { why?: string[] }).why ?? [] }; }
};

export const observe = {
  /** n0: the PM opens a phase for a goal — a phase at discussion, its book says it opened with the title, a second open is a new one. */
  async p1_start() {
    const w = world();
    try {
      const first = await openPhase(w, "Sums", "skip blanks");
      const second = await openPhase(w, "Other", "other");
      return { distinct: first.id !== second.id, stage: first.stage, state: first.state, goal: first.goal, opened: partsOf(w, first.id, "opened").map((part) => part.text) };
    } finally { w.restore(); }
  },

  /** n1: the discussion's command to the PM names the context call and what is still open; an open question parks the stage as one wait. */
  async p1_cmd() {
    const bare = nextAction(phaseAt({}), new Map());
    const done = nextAction(phaseAt(signedRecord()), new Map());
    const asked = nextAction(phaseAt({ questions: [{ id: "q1", text: "Which tag syntax?", blocking: true, stage: "discussion", by: "lp", at: 1 }] } as never), new Map());
    return {
      key: bare.key, waitsForPm: bare.waitsForPm, tool: bare.text.includes('lane_pilot_phase {action:"context"'), workflow: bare.text.includes("lp.brainstorm or lp.analyze"),
      open: bare.text.split("\n").filter((line) => line.startsWith("Open:")), doneOpen: done.text.split("\n").filter((line) => line.startsWith("Open:")),
      question: { key: asked.key, waitsForPm: asked.waitsForPm, text: asked.text.includes("q1 (blocking): Which tag syntax?") },
    };
  },

  /** n2: the discussion card is the signed context: documents with their hashes, the four risks and security, appetite, no-gos, requirements and decisions. */
  async p1_card() {
    const w = world();
    try {
      w.seed(...DOCS);
      const made = await openPhase(w);
      const signed = await w.phases.context({ phaseId: made.id, docs: DOCS, risks: { value: "v", usability: "u", feasibility: "f", viability: "via", security: "s" }, appetite: "one day", noGos: ["no OAuth", "no sync"], decisions: ["D1", "D2"], requirements: ["R1"] });
      const context = signed.record.context!;
      return { stage: signed.stage, docs: context.docs.map((doc) => [doc.path, doc.bytes > 0]), shaIsOfDocs: context.sha === contextSignature(context.docs), risks: Object.keys(context.risks ?? {}), appetite: context.appetite, noGos: context.noGos, decisions: context.decisions, requirements: context.requirements };
    } finally { w.restore(); }
  },

  /** n3: the appetite is named before any solution: a context without one is refused, and the machine's CONTEXT.md puts «Appetite» before the decisions. */
  async p1_appetite() {
    const w = world();
    try {
      w.seed(DOCS[0]!);
      const made = await openPhase(w);
      const bare = await refusal(w.phases.context({ phaseId: made.id, docs: [DOCS[0]!], ...CARD, appetite: "  " }));
      const doc = contextDoc(phaseAt({}), { decisions: [{ id: "D1", text: "JSON store" }], appetite: "two days", no_gos: ["no sync"] }).content;
      const heads = doc.split("\n").filter((line) => line.startsWith("## "));
      return { bare: bare?.why ?? null, stage: getPhase(w.db, made.id)!.stage, heads, appetite: doc.split("## Appetite\n")[1]?.split("\n")[0] };
    } finally { w.restore(); }
  },

  /** n4: four risk kinds are named, «none» is an answer; the refusal names the kinds missing, in order. */
  async p1_risks() {
    const none = discussionGate(signedRecord({ risks: { value: "x" } }));
    const complete = discussionGate(signedRecord({ risks: RISKS }));
    return { kinds: [...RISK_KINDS], missing: why(none).filter((line) => line.startsWith("risks not named")), complete: complete.ok, blank: why(discussionGate(signedRecord({ risks: { ...RISKS, feasibility: "  " } }))) };
  },

  /** n5: every field of the card is checked, each on its own: documents, risks, appetite, no-gos, and the signature of the documents. */
  async p1_validate() {
    const lines = (over: Parameters<typeof signedRecord>[0]) => why(discussionGate(signedRecord(over)));
    const noRisks = lines({ risks: {} });
    const oneRisk = lines({ risks: { ...RISKS, viability: "" } });
    return { good: discussionGate(signedRecord()).ok, noDocs: why(discussionGate({})).filter((line) => line.startsWith("no context documents")).length,
      noRisks: noRisks.map((line) => line.split(":")[0]), oneRisk, noAppetite: lines({ appetite: "" }), noGos: lines({ noGos: [] }), blankNoGo: lines({ noGos: [" "] }),
      swapped: why(discussionGate({ context: { ...signedRecord().context!, sha: "f".repeat(64) } })), legacy: discussionGate({ context: { docs: [], sha: "x", signedAt: 1, legacy: true, risks: RISKS } }).ok };
  },

  /** n6: the plan's pieces: each a task with owned paths and checks, a promise in three words, links to pieces of the plan, an acceptance line that names a command the task runs. */
  async p1_pieces() {
    const noThen = piece("a"); noThen.promise = { given: "g", when: "w", then: " " };
    return { good: pieceProblems(piece("a")), noThen: pieceProblems(noThen), noOwns: pieceProblems(piece("a", 1, { owns_paths: [] })),
      command: pieceProblems(piece("a", 1, { acceptance: ["`npm run lint` is green"] })), commandOk: pieceProblems(piece("a", 1, { acceptance: ["`npm test` is green"], verification: [{ command: "npm test" }] })),
      link: waveProblems([piece("a", 1, { depends_on: ["gone"] })]), linked: waveProblems([piece("a"), piece("b", 2, { depends_on: ["a"] })]) };
  },

  /** n7: the machine writes the discussion: an analysis becomes CONTEXT.md in the phase folder, and the context is signed over that very file. */
  async p1_write() {
    const output = { decisions: [{ id: "D1", text: "store in JSON" }], risks: [{ kind: "value", text: "totals are missed" }], open_questions: ["Which tag syntax?"], appetite: "two days", no_gos: ["no sync"], scope_verdict: "small" };
    const run = await analysis(output);
    const files = run.writes.filter((write) => /CONTEXT\.md$/.test(write.path));
    return { stage: run.stage, files: files.map((write) => write.path.split("/").slice(-1)[0]), folder: files.map((write) => write.path.split("/").slice(0, -1).join("/")), signedDocs: run.signedDocs, onDiskIsSigned: run.onDiskIsSigned, text: run.text, questions: run.questions, book: run.book };
  },

  /** n8: the documents go to disk through the host with the hash of the bytes the writer read, are committed by explicit path, and are read again for the signature. */
  async p1_docs() {
    const output = { decisions: [{ id: "D1", text: "store in JSON" }], risks: [{ kind: "security", text: "no secrets in notes" }], open_questions: [], appetite: "two days", no_gos: ["no sync"], scope_verdict: "small" };
    const earlier = "# earlier decisions\nkeep me";
    const run = await analysis(output, earlier);
    const analysisFiles = (path: string) => /(CONTEXT|SECURITY)\.md$/.test(path);
    return { earlierSha: sha256Hex(earlier), writes: run.writes.filter((write) => analysisFiles(write.path)).map((write) => [write.path.split("/").at(-1), write.expectedSha256, write.status]), commits: run.commits.filter((commit) => commit.message.endsWith("from the analysis")).map((commit) => [commit.paths.map((path) => path.split("/").at(-1)), commit.message.replace(/ph_\w+/, "ph")]), signedDocs: run.signedDocs.map((path) => path.split("/").at(-1)), kept: run.text.includes("## Earlier decisions (kept)") && run.text.includes("keep me"), onDiskIsSigned: run.onDiskIsSigned, stage: run.stage };
  },

  /** n9: until every document has bytes the context is not whole: no signature, the phase stays at discussion and no plan can be submitted. */
  async p1_docs_ready() {
    const w = world();
    try {
      w.seed(...DOCS);
      w.texts.set(DOCS[1]!, "");
      const made = await openPhase(w);
      const held = await refusal(w.phases.context({ phaseId: made.id, docs: DOCS, ...CARD }));
      const stage = getPhase(w.db, made.id)!.stage;
      const plan = await refusal(Promise.resolve().then(() => w.phases.plan({ phaseId: made.id, items: [piece("a")], by: "pm" })));
      w.texts.set(DOCS[1]!, "# FAQ\nnow written");
      const whole = await w.phases.context({ phaseId: made.id, docs: DOCS, ...CARD });
      return { held: held?.why ?? null, stage, plan: plan?.message ?? null, whole: whole.stage };
    } finally { w.restore(); }
  },

  /** n10: the goal is revised only in discussion or planning; the plan stays but its check is void and a revision is counted and booked. */
  async p1_scope() {
    const { w, id } = await planningWorld();
    try {
      const planned = getPhase(w.db, id)!;
      const sha = planned.record.plan!.sha;
      savePhase(w.db, id, { record: { ...planned.record, plan: { ...planned.record.plan!, admittedSha: sha, critique: { decision: "approve", by: "c", independence: { ok: true, why: "ok" } } } }, at: 3 });
      savePhase(w.db, id, { stage: "execution", at: 4 });
      const late = await refusal(Promise.resolve().then(() => w.phases.revise({ phaseId: id, goal: "new", note: "too late" })));
      savePhase(w.db, id, { stage: "planning", at: 5 });
      const revised = w.phases.revise({ phaseId: id, goal: "sums skip blanks", note: "the owner cut a screen" });
      return { late: late?.message ?? null, goal: revised.goal, revisions: revised.record.scope?.revisions, admitted: revised.record.plan?.admittedSha ?? null, critique: revised.record.plan?.critique ?? null, kept: revised.record.plan?.items.length,
        book: partsOf(w, id, "revised").map((part) => part.text) };
    } finally { w.restore(); }
  },

  /** n11: the documents the plan stands on are read again at the plan check; one edited after the signature sends the phase back to discussion. */
  async p1_files_current() {
    const { w, id } = await planningWorld();
    try {
      const same = await refusal(w.phases.planCheck({ phaseId: id, decision: "approve", by: "critic" }));
      const sameParts = partsOf(w, id, "context_changed").length;
      w.texts.set(DOCS[0]!, "# docs/CONTEXT.md\nedited after the signature");
      const changed = await refusal(w.phases.planCheck({ phaseId: id, decision: "approve", by: "critic" }));
      return { same: same?.message ?? null, sameParts, changed: changed?.message ?? null, changedParts: partsOf(w, id, "context_changed").map((part) => part.text) };
    } finally { w.restore(); }
  },

  /** n12: the context is signed by a person: with owner.words on the machine's signature waits for his word, off it goes on; a no unsigns it. */
  async p1_confirm() {
    const out: Record<string, unknown> = {};
    for (const mode of ["off", "on"] as const) {
      const w = world(mode);
      try {
        w.seed(DOCS[0]!);
        const made = await openPhase(w);
        const signed = await w.phases.context({ phaseId: made.id, docs: [DOCS[0]!], ...CARD });
        const entry: Record<string, unknown> = { stage: signed.stage, awaits: partsOf(w, made.id, "awaits_signature").length };
        if (mode === "on") {
          const yes = await w.phases.word({ phaseId: made.id, turn: "context", decision: "yes", text: "да", by: "owner via screen" });
          entry.afterYes = yes.stage;
        }
        out[mode] = entry;
      } finally { w.restore(); }
    }
    const w = world("on");
    try {
      w.seed(DOCS[0]!);
      const made = await openPhase(w);
      const bare = await refusal(w.phases.context({ phaseId: made.id, docs: [DOCS[0]!], risks: RISKS }));
      out.noDecisions = bare?.why ?? null;
    } finally { w.restore(); }
    return out;
  },

  /** n13: the context gate holds the signed edition: a book part with its signature comes before the move to planning. */
  async p1_signed() {
    const w = world();
    try {
      w.seed(DOCS[0]!);
      const made = await openPhase(w);
      const moved = await w.phases.context({ phaseId: made.id, docs: [DOCS[0]!], ...CARD });
      const parts = listParts(w.db, made.id);
      const signed = parts.find((part) => part.kind === "signed");
      const stage = parts.find((part) => part.kind === "stage" && part.text.includes("planning"));
      return { sha: moved.record.context!.sha, text: signed?.text ?? null, before: !!signed && !!stage && signed.seq < stage.seq };
    } finally { w.restore(); }
  },

  /** n14: the signature is ready for planning once its basis is in the book: the book is a chain, and the signed part is in it before the phase moves on. */
  async p1_book_ready() {
    const w = world();
    try {
      w.seed(DOCS[0]!);
      const made = await openPhase(w);
      await w.phases.context({ phaseId: made.id, docs: [DOCS[0]!], ...CARD });
      const parts = listParts(w.db, made.id);
      const chained = parts.every((part, index) => part.seq === index + 1 && (index === 0 || part.prevHash === parts[index - 1]!.hash));
      const signed = parts.findIndex((part) => part.kind === "signed");
      const moved = parts.findIndex((part) => part.kind === "stage" && part.text.includes("→ planning"));
      return { kinds: parts.map((part) => `${part.section}/${part.kind}`), chained, signedBeforeMove: signed >= 0 && signed < moved, seqs: parts.map((part) => part.seq) };
    } finally { w.restore(); }
  },

  /** n15: after the signature the phase goes to planning and the plan is built on the very edition that was signed. */
  async p2_start() {
    const off = world("off");
    try {
      off.seed(DOCS[0]!);
      const made = await openPhase(off);
      const moved = await off.phases.context({ phaseId: made.id, docs: [DOCS[0]!], ...CARD });
      const planned = off.phases.plan({ phaseId: made.id, items: [piece("a")], by: "planner" });
      const move = listParts(off.db, made.id).find((part) => part.kind === "stage")?.text ?? null;
      const early = await openPhase(off, "Early", "no context yet");
      const refused = await refusal(Promise.resolve().then(() => off.phases.plan({ phaseId: early.id, items: [piece("a")], by: "planner" })));
      return { stage: moved.stage, move, planContext: planned.record.plan?.contextSha === moved.record.context?.sha, early: refused?.message ?? null };
    } finally { off.restore(); }
  },

  /** n16: without the context documents no plan is queued: the gate says so, the phase stays at discussion and refuses a plan. */
  async p2_context() {
    const missing = why(discussionGate({}));
    const empty = signedRecord();
    empty.context!.docs[0]!.bytes = 0;
    const w = world();
    try {
      const made = await openPhase(w);
      const refused = await refusal(Promise.resolve().then(() => w.phases.plan({ phaseId: made.id, items: [piece("a")], by: "planner" })));
      return { missing: missing.filter((line) => line.startsWith("no context documents")).length, empty: why(discussionGate(empty)).filter((line) => line.endsWith("is empty")), stage: getPhase(w.db, made.id)!.stage, plan: refused?.message ?? null };
    } finally { w.restore(); }
  },

  /** n17: a plan is admitted only on the signed context, with a matching composition and an independent pass; each failure names its reason. */
  async p2_admission() {
    const items = [piece("a"), piece("b", 2, { depends_on: ["a"] })];
    const good = planGate(plannedRecord(items));
    const stale = plannedRecord(items, { contextSha: "f".repeat(64), sha: planSignature(items, "f".repeat(64)) });
    const noCheck = plannedRecord(items); delete (noCheck.plan as { critique?: unknown }).critique;
    const asked = plannedRecord(items, { critique: { decision: "changes_requested", by: "critic", summary: "split b" } });
    return { good: good.ok, stale: why(planGate(stale)).filter((line) => line.includes("signed context")).length, noContext: why(planGate({ plan: plannedRecord(items).plan })).filter((line) => line.includes("signed context")).length,
      noCheck: why(planGate(noCheck)).filter((line) => line.startsWith("no independent plan check")).length, asked: why(planGate(asked)) };
  },

  /** n18: a legacy phase has no signed discussion: it is at planning at once with a legacy context, a plan is queued, and the admission still wants its independent check. */
  async p2_legacy() {
    const w = world();
    try {
      const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Old", goal: "already planned", legacy: true });
      const queued = w.phases.plan({ phaseId: made.id, items: [piece("a")], objective: "o", premortem: ["r1", "r2", "r3"], by: "pm" });
      const checked = await refusal(w.phases.planCheck({ phaseId: made.id, decision: "approve", by: "critic" }));
      const normal = await openPhase(w, "New", "fresh");
      return { stage: made.stage, legacy: made.record.context?.legacy, docs: made.record.context?.docs.length, queued: queued.stage, admitted: queued.record.plan?.admittedSha ?? null, checked: checked?.why ?? checked?.message ?? null,
        normalLegacy: normal.record.context?.legacy ?? null, normalStage: normal.stage };
    } finally { w.restore(); }
  },

  /** n19: the plan graph runs without a research step unless the phase asks, and the independent critic still runs. */
  async p2_cmd() {
    const stubs = { plan: { task_count: 1 }, lint: { ok: true }, plan_critic: { status: "pass" } };
    const bare = await runSim("lp.plan", { input: { goal: "g" }, mode: "full", stubs: stubs as never });
    const asked = await runSim("lp.plan", { input: { goal: "g", skip_research: false }, mode: "full", stubs: stubs as never });
    const ran = (sim: typeof bare) => [...new Set(sim.calls.map((call) => call.node))];
    return { bare: { skipped: bare.skipped, ran: ran(bare), status: bare.summary.status }, asked: { skipped: asked.skipped, ran: ran(asked), status: asked.summary.status } };
  },

  /** n20: the plan is built on the signed edition: a plan that names another context edition is refused, whatever else holds. */
  async p2_signed_input() {
    const items = [piece("a")];
    const other = plannedRecord(items, { contextSha: "c".repeat(64), sha: planSignature(items, "c".repeat(64)) });
    const orphan = { plan: plannedRecord(items).plan };
    return { ok: planGate(plannedRecord(items)).ok, other: why(planGate(other)), orphan: why(planGate(orphan as never)).filter((line) => line.includes("signed context")) };
  },

  /** n21: the researcher of the discussion (lp.analyze gather) comes first and may come back when the confidence is low; the plan's research step is optional. */
  async p2_researcher() {
    const run = (confidence: number[]) => runSim("lp.analyze", { input: { goal: "g", scope: "s", depth: "standard", ask_owner: false, owner_card: "x" }, stubs: { assess: confidence.map((value) => ({ confidence: value, stalled: false, open_questions: [] })) } as never });
    const sure = await run([90]);
    const unsure = await run([40, 90]);
    return { sure: sure.path, unsure: unsure.path };
  },

  /** n22: the planner is a step of its own, handed the plan's context; a critic's rework goes back to it and the revision meets a critic again. */
  async p2_planner() {
    const rework = await runSim("lp.plan", { input: { goal: "g", plan_sha: "abc" }, mode: "full", stubs: { plan: { task_count: 1 }, lint: { ok: true }, plan_critic: [{ status: "rework" }, { status: "pass" }] } as never });
    const calls = rework.calls.filter((call) => call.node === "plan").map((call) => call.visit);
    return { skipped: rework.skipped, planVisits: calls, criticVisits: rework.calls.filter((call) => call.node === "plan_critic").map((call) => call.visit), roles: ["plan", "plan_critic"].map((id) => (rework.workflow.nodes.find((node) => node.id === id) as { role?: string } | undefined)?.role ?? null), status: rework.summary.status, path: rework.path.filter((id) => !rework.skipped.includes(id)) };
  },

  /** n23: the checker is a run of its own whose critic approved this plan: the gate refuses a plan checked in the planner's own session, by a changes verdict or without a run. */
  async p2_checker() {
    const { w, id, planSha } = await planningWorld();
    try {
      const steps: Array<[string, string, string, number, number]> = [["plan", "planner", "thr_planner", 10, 20], ["plan_critic", "plan-critic", "thr_critic", 30, 40]];
      seedPlanRun(w, "wf_same", [["plan", "planner", "thr_planner", 10, 20], ["plan_critic", "plan-critic", "thr_planner", 30, 40]], planSha);
      const same = await refusal(w.phases.planCheck({ phaseId: id, decision: "approve", by: "critic", wfRunId: "wf_same" }));
      const noRun = await refusal(w.phases.planCheck({ phaseId: id, decision: "approve", by: "critic" }));
      const asked = await refusal(w.phases.planCheck({ phaseId: id, decision: "changes_requested", by: "critic", summary: "split a", wfRunId: "wf_same" }));
      seedPlanRun(w, "wf_ok", steps, planSha);
      const admitted = await w.phases.planCheck({ phaseId: id, decision: "approve", by: "critic", wfRunId: "wf_ok" });
      return { same: same?.why ?? null, noRun: noRun?.why ?? null, asked: asked?.why ?? null, stage: admitted.stage, admitted: !!admitted.record.plan?.admittedSha, independence: admitted.record.plan?.critique?.independence?.ok ?? null, book: partsOf(w, id, "checked").length };
    } finally { w.restore(); }
  },

  /** n24: the order is judged by the journal's times: a critic that started before the planner was done is no check. */
  async p2_order() {
    const step = (role: string, thread: string, started: number, ended: number): JournalStep => ({ nodeId: role === "planner" ? "plan" : "plan_critic", role, state: "succeeded", threadId: thread, startedAt: started, endedAt: ended });
    const early = checkerIndependence("wf", [step("planner", "thr_p", 10, 50), step("plan-critic", "thr_c", 30, 60)], { pmThread: "thr_pm" });
    const later = checkerIndependence("wf", [step("planner", "thr_p", 10, 20), step("plan-critic", "thr_c", 30, 60)], { pmThread: "thr_pm" });
    const { w, id, planSha } = await planningWorld();
    try {
      seedPlanRun(w, "wf_early", [["plan", "planner", "thr_planner", 10, 50], ["plan_critic", "plan-critic", "thr_critic", 30, 60]], planSha);
      const refused = await refusal(w.phases.planCheck({ phaseId: id, decision: "approve", by: "critic", wfRunId: "wf_early" }));
      return { early: [early.ok, early.why], later: [later.ok, later.checkerStartedAt, later.plannedUntil], driver: refused?.why ?? null, stage: getPhase(w.db, id)!.stage };
    } finally { w.restore(); }
  },

  /** n25: the checker has the last word: a planner that wrote again after the check refuses the plan; a rework round ending in a critic admits it. */
  async p2_session_end() {
    const { w, id, planSha } = await planningWorld();
    try {
      seedPlanRun(w, "wf_after", [["plan", "planner", "thr_planner", 10, 20], ["plan_critic", "plan-critic", "thr_critic", 30, 40], ["plan", "planner", "thr_planner", 50, 60]], planSha);
      const after = await refusal(w.phases.planCheck({ phaseId: id, decision: "approve", by: "critic", wfRunId: "wf_after" }));
      seedPlanRun(w, "wf_rework", [["plan", "planner", "thr_planner", 10, 20], ["plan_critic", "plan-critic", "thr_critic", 30, 40], ["plan", "planner", "thr_planner", 50, 60], ["plan_critic", "plan-critic", "thr_critic2", 70, 80]], planSha);
      const admitted = await w.phases.planCheck({ phaseId: id, decision: "approve", by: "critic", wfRunId: "wf_rework" });
      return { after: after?.why ?? null, stage: admitted.stage, checker: admitted.record.plan?.critique?.independence?.checker, plannedUntil: admitted.record.plan?.critique?.independence?.plannedUntil };
    } finally { w.restore(); }
  },

  /** n26: a plan has a header (its goal) and three to five pre-mortem risks; one fewer or more is refused. */
  async p2_record() {
    const items = [piece("a")];
    const of = (plan: Record<string, unknown>) => why(planGate(plannedRecord(items, plan))).filter((line) => line.startsWith("the plan name"));
    return { good: planGate(plannedRecord(items)).ok, noGoal: of({ objective: " " }), two: of({ premortem: ["a", "b"] }), five: of({ premortem: ["a", "b", "c", "d", "e"] }), six: of({ premortem: ["a", "b", "c", "d", "e", "f"] }),
      blanks: of({ premortem: ["a", " ", "b", ""] }), alreadyMet: planGate({ ...signedRecord(), plan: { items: [], contextSha: signedRecord().context!.sha, sha: planSignature([], signedRecord().context!.sha), alreadyMet: { evidence: "e" }, critique: plannedRecord(items).plan!.critique } as never }).ok };
  },

  /** n27: the waves come out of depends_on; a cycle, a link to a piece the plan lacks, a wave not after its dependency's, or no wave is refused. */
  async p2_waves() {
    const cycle = [piece("a", 1, { depends_on: ["b"] }), piece("b", 1, { depends_on: ["a"] }), piece("c")];
    const computed = withComputedWaves([piece("a", 0), piece("b", 0, { depends_on: ["a"] }), piece("c", 0, { depends_on: ["b"] })] as never).map((row) => [row.id, row.wave]);
    return { cycle: waveProblems(cycle).map((line) => line.slice(0, 60)), cycleWaves: withComputedWaves(cycle.map((row) => ({ ...row, wave: 0 }))).map((row) => [row.id, row.wave]), computed,
      earlier: waveProblems([piece("a", 2), piece("b", 1, { depends_on: ["a"] })]).map((line) => line.slice(0, 50)), same: waveProblems([piece("a", 1), piece("b", 1, { depends_on: ["a"] })]).length,
      missing: waveProblems([piece("a", 1, { depends_on: ["gone"] })]), noWave: waveProblems([piece("a", 0)]), good: waveProblems([piece("a", 1), piece("b", 2, { depends_on: ["a"] })]),
      gate: why(planGate(plannedRecord(cycle))).filter((line) => line.includes("cycle")).length };
  },

  /** n28: every piece must become a work: a task id equal to the piece's, owned paths, a check that runs, a promise; the plan gate carries each refusal. */
  async p2_issue_troubles() {
    return { id: pieceProblems(piece("a", 1, { id: "other" })), owns: pieceProblems(piece("a", 1, { owns_paths: [] })), verification: pieceProblems(piece("a", 1, { verification: [] })), none: pieceProblems(piece("a", 1, { verification: [], verify: "none" })),
      command: pieceProblems(piece("a", 1, { verification: [{ command: " " }] })), ok: pieceProblems(piece("a")), gate: why(planGate(plannedRecord([piece("a", 1, { owns_paths: [] })]))).filter((line) => line.includes("cannot become a work")) };
  },

  /** n29: the plan document gate: pieces, composition against the signed context, an independent check — one refusal per gap, ids not repeated. */
  async p2_doc_gate() {
    const items = [piece("a"), piece("b", 2, { depends_on: ["a"] })];
    const rewritten = plannedRecord(items); (rewritten.plan as { items: PlanItem[] }).items = [piece("a"), piece("c", 2)];
    const twice = plannedRecord([piece("a"), piece("a")]);
    return { good: planGate(plannedRecord(items)).ok, drift: why(planGate(rewritten)).filter((line) => line.includes("signature does not match")).length, twice: why(planGate(twice)).filter((line) => line.includes("same id")).length,
      noPlan: why(planGate(signedRecord())), session: why(planGate(plannedRecord(items, { critique: { decision: "approve", by: "c", independence: { ok: false, why: "the checker stayed in the planner's session" } } }))) };
  },
};

/** The machine's analysis end to end on the real driver: the discussion's analysis run (a fake engine answers with `output`) is applied — CONTEXT.md written to the
 * phase folder through the host, committed, and signed — and the book and the files say what happened. `earlier` is a CONTEXT.md a person had written before. */
async function analysis(output: Record<string, unknown>, earlier?: string) {
  const runs = new Map<string, { status: string; output: Record<string, unknown> | null }>();
  const engine: Engine = {
    start: () => { runs.set("wf_a1", { status: "running", output: null }); return { runId: "wf_a1", created: true, done: new Promise(() => undefined) }; },
    get: (runId: string) => ({ runId, reason: null, error: null, failedNode: null, waiting: [], stopped: false, ...runs.get(runId)! }),
  };
  const w = world("off", engine);
  try {
    const made = await openPhase(w);
    savePhase(w.db, made.id, { runId: "run1", at: 2 });
    const path = `.agents/phases/${made.id}/CONTEXT.md`;
    if (earlier !== undefined) w.texts.set(path, earlier);
    await w.phases.tick();
    runs.set("wf_a1", { status: "succeeded", output });
    await w.phases.tick();
    const now = getPhase(w.db, made.id)!;
    const doc = now.record.context?.docs[0];
    return { stage: now.stage, writes: w.writes, commits: w.commits.map((commit) => ({ paths: commit.paths, message: commit.message })), signedDocs: now.record.context?.docs.map((row) => row.path) ?? [], text: w.texts.get(path) ?? "",
      onDiskIsSigned: !!doc && doc.sha256 === sha256Hex(w.texts.get(path) ?? ""), questions: (now.record.questions ?? []).map((question) => question.text), book: listParts(w.db, made.id).map((part) => part.kind) };
  } finally { w.restore(); }
}
