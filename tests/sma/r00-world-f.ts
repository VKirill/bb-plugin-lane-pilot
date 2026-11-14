// Region 0 (Phase graph), batch f: the roles per stage, the pause family, the stops, the returns, the correction, the answer and the compensation (n140 … n157, n1769).
// Every observation runs the REAL code of the node (the phase driver on a scratch database and a fake host, the phase logic, the workflow definitions) and returns plain JSON.
// tests/sma/four-proofs-r00-f.test.ts asserts on it and scripts/lp_drill/scenes/sma_r00_f.py proves the nodes that write no hub row. No model, no hub write, nothing outside the machine.
import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../src/rooms/core/server/core";
import { GENESIS, designGate, nextAction, partHash, pieceSha, planSignature, renderBook, type BookPart, type Phase, type PlanItem } from "../../src/rooms/phase/logic";
import { listParts, savePhase } from "../../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/plugin-db";
import { createPhaseDriver } from "../phase-driver";

const item = (id = "piece"): PlanItem => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id, owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["works"] } });
const msg = async (run: () => unknown): Promise<string> => { try { await run(); return "not refused"; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } };

/** The driver on a scratch database: the writer's stop can be made to fail (`stopFails`), a correction or a wave message is recorded in `sent`. */
async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const state = { stopFails: false };
  const sent: Array<{ threadId: string; text: string }> = [];
  harness.sdk.stub("threads.stop" as never, async () => { if (state.stopFails) throw new Error("host unreachable"); return {}; });
  harness.sdk.stub("threads.send" as never, async (input: { threadId: string; input?: Array<{ text?: string }> }) => { sent.push({ threadId: input.threadId, text: input.input?.[0]?.text ?? "" }); return {}; });
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list" as never, async () => []);
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  const dispatched: string[] = [];
  const reverted: string[] = [];
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    workflowEngine: { cancel: () => true, get: () => ({ status: "running" }), start: () => ({ runId: "wf", done: Promise.resolve() }) },
    dispatchWriter: async () => { dispatched.push("dispatch"); return { ok: true, taskId: "piece", runId: "run1" }; },
    rollback: { noteStopped: async () => ({ recorded: true }), revert: async (taskId: string) => { reverted.push(taskId); return { state: "merged", ok: true }; } },
    readWriterWorkspaceFile: async () => { throw new Error("no file"); },
  } as never).phases;
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "controls", goal: "one piece" });
  const attempt = (taskId: string, att: string, st: string, thread?: string) => {
    createTask(db, { id: taskId, runId: "run1", kind: "bb", contract: { ...item().task, id: taskId } });
    createAttempt(db, { id: att, runId: "run1", taskId });
    db.prepare("UPDATE lane_pilot_attempt SET state=?, thread_id=? WHERE id=?").run(st, thread ?? null, att);
  };
  const attemptState = (att: string) => (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id=?").get(att) as { state: string }).state;
  const executing = (over: Record<string, unknown> = {}, state: Phase["state"] = "active", stage: Phase["stage"] = "execution") => {
    const one = item();
    const sha = planSignature([one] as never, "ctx");
    savePhase(db, phase.id, { stage, state, runId: "run1", record: { ...phase.record, plan: { items: [one], sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: {}, startedAt: 1 }, ...over } as never, at: 2 });
  };
  const get = () => phases.status(phase.id).phase;
  const parts = (kind: string) => listParts(db, phase.id).filter((part) => part.kind === kind).map((part) => part.text);
  return { db, phases, id: phase.id, record: phase.record, state, sent, dispatched, reverted, attempt, attemptState, executing, get, parts };
}

const link = (seq: number, prev: string, text: string): BookPart => {
  const row = { seq, at: 1, section: "goal" as const, kind: "opened", text, prevHash: prev };
  return { ...row, hash: partHash(prev, row) };
};
const flow = (name: string) => (JSON.parse(readFileSync(`workflows/${name}.json`, "utf8")) as { nodes: Array<{ id: string; role?: string }> }).nodes;

export const observe = {
  /** n140 · roles per stage: the plan has researchers, a planner and a checker; the drawing a designer and a checker that is another role. */
  roles() {
    return { plan: flow("lp.plan").filter((node) => node.role).map((node) => [node.id, node.role]), draw: flow("lp.draw").filter((node) => node.role).map((node) => [node.id, node.role]) };
  },

  /** n141 · the role separateness: a drawing reviewed by its own designer is held, another role opens the gate, none is held too. */
  separateness() {
    const drawing = { paths: ["d/UI-SPEC.md"], sha256: "d", designer: "design-lead", feasible: true };
    const gate = (reviewer: string | undefined) => { const out = designGate({ design: { decision: "needed", why: "x", drawing: { ...drawing, ...(reviewer ? { reviewer } : {}) } } }); return out.ok ? "open" : out.why.join("; "); };
    return { own: gate("design-lead"), other: gate("ui-review"), none: gate(undefined) };
  },

  /** n142 · a plan that is not the one that was checked is not issued: the phase refuses, nothing is dispatched, nothing is recorded as issued. */
  async parentGuard() {
    const f = await host();
    const one = item();
    const sha = planSignature([one] as never, "ctx");
    f.executing({ plan: { items: [one], sha, admittedSha: "e".repeat(64), contextSha: "ctx" } });
    const refused = await msg(() => f.phases.drive(f.get()));
    return { refused, dispatched: f.dispatched, issued: f.get().record.execution?.issued };
  },

  /** n143 · the phase book as the person reads it: the goal, the chain's state; a rewritten part is named. */
  book() {
    const first = link(1, GENESIS, "phase opened");
    const second = link(2, first.hash, "context signed");
    const shown = { id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sums", goal: "sums are right", stage: "acceptance", state: "active", record: {}, edition: 1, createdAt: 0, updatedAt: 0 } as Phase;
    const intact = renderBook(shown, [first, second]);
    return { head: intact.split("\n")[0], status: intact.split("\n")[2], goal: intact.includes("sums are right"), broken: renderBook(shown, [first, { ...second, text: "rewritten" }]).split("\n")[2] };
  },

  /** n144 · a pause by the PM's intent: the phase is paused, the pass issues none of its pieces. */
  async pause() {
    const f = await host();
    f.executing();
    const paused = f.phases.setState({ phaseId: f.id, state: "pause", by: "pm" });
    const after = await f.phases.drive(f.get());
    return { state: paused.state, afterDrive: after.state, issued: after.record.execution?.issued, dispatched: f.dispatched, booked: f.parts("pause") };
  },

  /** n145 · a requested pause becomes paused before any issue. */
  async requested() {
    const f = await host();
    f.executing({}, "pause_requested");
    const out = await f.phases.drive(f.get());
    return { state: out.state, issued: out.record.execution?.issued, dispatched: f.dispatched };
  },

  /** n146 · a paused phase stands: it asks nothing of the PM and names the resume. */
  async paused() {
    const f = await host();
    f.executing();
    f.phases.setState({ phaseId: f.id, state: "pause", by: "owner" });
    const action = nextAction(f.get(), new Map());
    return { waitsForPm: action.waitsForPm, text: action.text, id: f.id };
  },

  /** n147 + n1769 · the interrupt by explicit choice: refused on an active or a quiet phase; a stop not yet observed keeps the phase `pause_requested` with the open stops named,
   *  the next pass asks again and, once the stop is observed, the phase is paused and the piece goes again as a redo. */
  async interrupt() {
    const f = await host();
    const one = item();
    f.executing({ execution: { issued: { piece: "piece" }, issuedSha: { piece: pieceSha(one) }, startedAt: 1 } });
    const active = await msg(() => f.phases.interrupt({ phaseId: f.id }));
    f.attempt("piece", "att1", "running", "thr_writer");
    f.phases.setState({ phaseId: f.id, state: "pause", by: "owner" });
    f.state.stopFails = true;
    const first = await f.phases.interrupt({ phaseId: f.id, words: "stop the work", by: "owner" });
    const mid = f.get();
    f.state.stopFails = false;
    const again = await f.phases.drive(f.get());
    const quiet = await host();
    quiet.executing({ execution: { issued: { piece: "piece" }, issuedSha: { piece: pieceSha(one) }, startedAt: 1 } }, "paused");
    return { active, unconfirmed: first.unconfirmed.length, midState: mid.state, midInterrupting: mid.record.interrupting?.by ?? null, midNamed: (mid.record.interrupting?.unconfirmed ?? []).length,
      afterState: again.state, afterInterrupting: again.record.interrupting ?? null, issuedSha: again.record.execution?.issuedSha?.piece, attempt: f.attemptState("att1"),
      quiet: await msg(() => quiet.phases.interrupt({ phaseId: quiet.id })), booked: f.parts("interrupting").length };
  },

  /** n148 · continue: the resume word moves a paused phase to active; a closed phase is never resumed. */
  async resume() {
    const f = await host();
    f.phases.setState({ phaseId: f.id, state: "pause", by: "owner" });
    const paused = f.get().state;
    const resumed = f.phases.setState({ phaseId: f.id, state: "resume", by: "owner" }).state;
    f.phases.setState({ phaseId: f.id, state: "close", words: "done", by: "owner" });
    return { paused, resumed, closedRefusal: await msg(() => f.phases.setState({ phaseId: f.id, state: "resume", by: "owner" })) };
  },

  /** n149 · stop: the running writer is stopped first and only then the phase is stopped; a stop not observed keeps the phase open and asks again. */
  async stop() {
    const f = await host();
    f.executing({ execution: { issued: { piece: "piece" }, startedAt: 1 } });
    f.attempt("piece", "att1", "running", "thr_writer");
    f.state.stopFails = true;
    const first = await f.phases.stop({ phaseId: f.id, by: "owner", words: "wrong goal" });
    const open = { unconfirmed: first.unconfirmed.length, state: first.phase.state, stopping: first.phase.record.stopping?.words ?? null, attempt: f.attemptState("att1") };
    f.state.stopFails = false;
    const after = await f.phases.drive(f.get());
    return { open, state: after.state, stopping: after.record.stopping ?? null, attempt: f.attemptState("att1"), booked: f.parts("work_stopped").at(-1) };
  },

  /** n150 · close in words: refused without them, with them the phase is closed, the words are kept with who said them. */
  async close() {
    const f = await host();
    const refused = await msg(() => f.phases.setState({ phaseId: f.id, state: "close" }));
    const blank = await msg(() => f.phases.setState({ phaseId: f.id, state: "close", words: "   " }));
    const closed = f.phases.setState({ phaseId: f.id, state: "close", words: "the owner stopped the goal", by: "owner" });
    return { refused, blank, state: closed.state, stage: closed.stage, closing: { by: closed.record.closing?.by, words: closed.record.closing?.words } };
  },

  /** n151 + n152 · return to execution: only from acceptance on a frozen verdict; the preparation is withdrawn, the piece goes out as the next redo and the return's note rides with it and is booked. */
  async returnExec() {
    const f = await host();
    const one = item();
    const verdict = { state: "passed" as const, detail: "ok", mainSha: "h", at: 1, inputSha: "i" };
    const executing = { execution: { issued: { piece: "piece" }, issuedSha: { piece: pieceSha(one) }, startedAt: 1 } };
    f.executing({ ...executing, verification: {} }, "active", "verification");
    const early = await msg(() => f.phases.returnTo({ phaseId: f.id, to: "execution", note: "back" }));
    f.executing({ ...executing, verification: { verdict }, acceptance: { lines: [], at: 1, accepted: false }, candidate: { branch: "phase/x", trees: { "/repo": { path: "/repo/wt", startSha: "s" } }, verified: { "/repo": "v" } } }, "active", "acceptance");
    const noNote = await msg(() => f.phases.returnTo({ phaseId: f.id, to: "execution", note: "  " }));
    const back = f.phases.returnTo({ phaseId: f.id, to: "execution", note: "the header is wrong", by: "owner" });
    return { early, noNote, stage: back.stage, verification: back.record.verification ?? null, acceptance: back.record.acceptance ?? null, verified: back.record.candidate?.verified ?? null,
      branchKept: back.record.candidate?.branch ?? null, issuedSha: back.record.execution?.issuedSha?.piece, returnNote: back.record.execution?.returnNote, booked: f.parts("return") };
  },

  /** n153 · a correction goes to the writer that is running, and to no other; the book says where it went. */
  async correct() {
    const f = await host();
    f.attempt("task-r", "att-r", "running", "thr_w");
    f.attempt("task-q", "att-q", "queued");
    f.executing({ execution: { issued: { piece: "task-r", q: "task-q" }, startedAt: 1 } });
    const out = await f.phases.correct({ phaseId: f.id, note: "keep the blank cell" });
    return { sent: out.sent, threads: f.sent.map((row) => row.threadId), text: f.sent[0]?.text, booked: f.parts("correction") };
  },

  /** n154 · stop the wave: the queued pieces are canceled, a running writer stays at work, the phase is held. */
  async wave() {
    const f = await host();
    f.attempt("task-q", "att-q", "queued");
    f.attempt("task-r", "att-r", "running", "thr_w");
    f.executing({ execution: { issued: { piece: "task-q", run: "task-r" }, startedAt: 1 } });
    const out = await f.phases.stopWave({ phaseId: f.id, by: "owner" });
    return { canceled: out.canceled, state: out.phase.state, queued: f.attemptState("att-q"), running: f.attemptState("att-r"), booked: f.parts("wave_stopped") };
  },

  /** n155 · the answer is written onto its question; an unknown question is refused. */
  async answer() {
    const f = await host();
    f.phases.question({ phaseId: f.id, text: "Which total?", blocking: true, by: "pm" });
    const unknown = await msg(() => f.phases.answer({ phaseId: f.id, questionId: "nope", answer: "x" }));
    const open = f.phases.status(f.id).openQuestions.length;
    const answered = f.phases.answer({ phaseId: f.id, questionId: "q1", answer: "the daily one", by: "owner" });
    const q = answered.record.questions?.[0];
    return { unknown, open, openAfter: f.phases.status(f.id).openQuestions.length, question: q ? { answer: q.answer, answeredBy: q.answeredBy } : null, booked: f.parts("answer") };
  },

  /** n156 · compensation reverts only this phase's accepted pieces, and the book records each revert's state. */
  async compensate() {
    const f = await host();
    f.attempt("task-done", "att-done", "accepted");
    f.attempt("task-live", "att-live", "running");
    f.attempt("task-other", "att-other", "accepted");
    const one = item();
    const sha = planSignature([one] as never, "ctx");
    f.executing({ plan: { items: [one, { ...one, id: "live" }], sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: { piece: "task-done", live: "task-live" }, startedAt: 1 } }, "closed");
    const out = await f.phases.compensate({ phaseId: f.id, note: "undo the piece" });
    return { reverted: f.reverted, results: out.results, booked: f.parts("compensated"), live: f.attemptState("att-live") };
  },
};
