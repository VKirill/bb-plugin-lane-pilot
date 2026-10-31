import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { createPhaseDriver } from "../../src/rooms/phase/server/driver";
import { contextSignature, planSignature, sha256, type PlanItem } from "../../src/rooms/phase/logic";
import { listParts, savePhase } from "../../src/rooms/phase/store";
import { piecePlan } from "../../src/rooms/phase/stages";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage";

const item = (id = "piece"): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" },
  task: { id, owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["works"] },
});

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: Array<{ threadId: string; text: string }> = [];
  harness.sdk.stub("threads.stop" as never, async () => ({}));
  harness.sdk.stub("threads.send" as never, async (input: { threadId: string; input?: Array<{ text?: string }> }) => { sent.push({ threadId: input.threadId, text: input.input?.[0]?.text ?? "" }); return {}; });
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list" as never, async () => []);
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  const plans: string[] = [];
  const files = new Map<string, string>([["docs/CONTEXT.md", "a".repeat(64)]]);
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    workflowEngine: { cancel: () => true, get: () => null, start: () => ({ runId: "wf", done: Promise.resolve() }) },
    dispatchWriter: async (input: { plan?: string }) => { plans.push(input.plan ?? ""); return { ok: true, taskId: "task-piece", runId: "run1" }; },
    readWriterWorkspaceFile: async ({ path }: { path: string }) => ({ sha256: files.get(path) ?? sha256("missing"), sizeBytes: 4, content: "x" }),
  } as never).phases;
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "controls", goal: "one piece" });
  return { db, phases, id: phase.id, phase, plans, files, sent };
}

const analysis = "The plan missed the empty-cell case; a check per promise would have caught it.";

function seedRetro(db: ReturnType<typeof openDatabase>, runId: string) {
  db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(runId, "retrospective", 1, "sha", "{}", "projA", "succeeded", 1, 1);
  const input = JSON.stringify({ with: {}, via: { mode: "artifact", fromStep: "retro#1", fromThreadId: "thr_retro", handoff: analysis } });
  const receipt = JSON.stringify({ executor: "agent", inputSha256: sha256(input), threadId: "thr_stage" });
  db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,input_json,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(runId, "stage#1", "stage#1", "stage", 1, "succeeded", input, receipt, 1, 2, 2);
}

describe("phase controls", () => {
  it("[sma:p1_files_current] sends the phase back when a signed context file no longer has its hash", async () => {
    const f = await host();
    const docs = [{ path: "docs/CONTEXT.md", sha256: "a".repeat(64), bytes: 20 }];
    const record = { context: { docs, sha: contextSignature(docs), signedAt: 1, risks: { value: "x", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["none"] }, plan: { items: [item()], contextSha: contextSignature(docs), sha: "b".repeat(64) } };
    savePhase(f.db, f.id, { stage: "planning", record: record as never, at: 2 });
    f.files.set("docs/CONTEXT.md", "c".repeat(64));
    await expect(f.phases.planCheck({ phaseId: f.id, decision: "approve", by: "critic" })).rejects.toThrow(/changed after the context was signed/);
    expect(listParts(f.db, f.id).some((part) => part.kind === "context_changed")).toBe(true);
  });

  it("[sma:p1_scope] revises the goal only in discussion or planning, and the old plan is checked again", async () => {
    const f = await host();
    savePhase(f.db, f.id, { stage: "execution", at: 2 });
    expect(() => f.phases.revise({ phaseId: f.id, goal: "new", note: "the owner cut a screen" })).toThrow(/discussion or planning/);
    savePhase(f.db, f.id, { stage: "planning", record: { ...f.phase.record, plan: { items: [item()], contextSha: "c", sha: "s", admittedSha: "s", critique: { decision: "approve", by: "c", independence: { ok: true, why: "ok" } } } } as never, at: 3 });
    const revised = f.phases.revise({ phaseId: f.id, goal: "sums skip blanks", note: "the owner cut a screen" });
    expect(revised.goal).toBe("sums skip blanks");
    expect(revised.record.scope?.revisions).toBe((f.phase.record.scope?.revisions ?? 0) + 1);
    expect(revised.record.plan?.admittedSha).toBeUndefined();
    expect(revised.record.plan?.critique).toBeUndefined();
  });

  it("[sma:p6_withdrawal] withdraws an unissued piece with a note and refuses one already issued", async () => {
    const f = await host();
    const items = [item("keep"), item("drop")];
    const sha = planSignature(items, "ctx");
    savePhase(f.db, f.id, { stage: "execution", record: { ...f.phase.record, plan: { items, contextSha: "ctx", sha, admittedSha: sha }, execution: { issued: { keep: "task-keep" }, startedAt: 1 } } as never, at: 2 });
    expect(() => f.phases.withdraw({ phaseId: f.id, pieces: ["keep"], note: "no" })).toThrow(/issued/);
    const out = f.phases.withdraw({ phaseId: f.id, pieces: ["drop"], note: "the owner dropped it" });
    expect(out.record.plan?.items.map((row) => row.id)).toEqual(["keep"]);
    expect(out.record.scope?.withdrawn).toContain("drop");
    expect(out.record.plan?.admittedSha).toBe(planSignature([item("keep")], "ctx"));
    expect(listParts(f.db, f.id).some((part) => part.kind === "scope_withdrawn" && part.text.includes("the owner dropped it"))).toBe(true);
  });

  it("[sma:px_wave] cancels the queued pieces of the wave and leaves a running writer at work", async () => {
    const f = await host();
    createTask(f.db, { id: "task-q", runId: "run1", kind: "bb", contract: item().task });
    createTask(f.db, { id: "task-r", runId: "run1", kind: "bb", contract: item("run").task });
    createAttempt(f.db, { id: "att-q", runId: "run1", taskId: "task-q" });
    createAttempt(f.db, { id: "att-r", runId: "run1", taskId: "task-r" });
    f.db.prepare("UPDATE lane_pilot_attempt SET state='queued' WHERE id='att-q'").run();
    f.db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='thr_w' WHERE id='att-r'").run();
    savePhase(f.db, f.id, { stage: "execution", runId: "run1", record: { ...f.phase.record, execution: { issued: { piece: "task-q", run: "task-r" }, startedAt: 1 } } as never, at: 2 });
    const out = await f.phases.stopWave({ phaseId: f.id, by: "owner" });
    expect(out.canceled).toEqual(["task-q"]);
    expect(out.phase.state).toBe("paused");
    expect(f.db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='att-r'").get()).toMatchObject({ state: "running" });
  });

  it("[sma:px_close] [sma:px_continue] closes only with words, and resume is the word that moves a paused phase", async () => {
    const f = await host();
    expect(() => f.phases.setState({ phaseId: f.id, state: "close" })).toThrow(/carries the words/);
    const closed = f.phases.setState({ phaseId: f.id, state: "close", words: "the owner stopped the goal", by: "owner" });
    expect(closed.state).toBe("closed");
    expect(closed.record.closing).toMatchObject({ words: "the owner stopped the goal", by: "owner" });
    const paused = f.phases.setState({ phaseId: f.id, state: "pause", by: "owner" });
    expect(paused.state).toBe("paused");
    expect(f.phases.setState({ phaseId: f.id, state: "resume", by: "owner" }).state).toBe("active");
  });

  it("[sma:px_answer] writes the answer onto the question and refuses an unknown one", async () => {
    const f = await host();
    const asked = f.phases.question({ phaseId: f.id, text: "Which total?", blocking: true, by: "pm" });
    expect(f.phases.status(asked.id).openQuestions).toHaveLength(1);
    expect(() => f.phases.answer({ phaseId: f.id, questionId: "nope", answer: "x" })).toThrow(/no question/);
    const answered = f.phases.answer({ phaseId: f.id, questionId: "q1", answer: "the daily one", by: "owner" });
    expect(f.phases.status(answered.id).openQuestions).toEqual([]);
    expect(answered.record.questions?.[0]).toMatchObject({ answer: "the daily one", answeredBy: "owner" });
  });

  it("[sma:p4_issue] [sma:p4_binding] [sma:p4_drawing] issues the piece as its own work and carries the phase drawing in the plan", async () => {
    const previous = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
    process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = "off";
    try {
      const f = await host();
      const one = { ...item(), task: { ...item().task, owns_paths: ["ui/app.tsx"] } };
      const sha = planSignature([one], "ctx");
      const drawing = { paths: [".agents/phases/ph/design/UI-SPEC.md"], sha256: "d".repeat(64), designer: "design-lead", reviewer: "ui-review", feasible: true };
      savePhase(f.db, f.id, { stage: "execution", runId: "run1", record: { ...f.phases.status(f.id).phase.record, ownerWords: false, plan: { items: [one], sha, admittedSha: sha, contextSha: "ctx" }, design: { decision: "needed", why: "screens", drawing }, execution: { issued: {}, startedAt: 1 } } as never, at: 2 });
      const issued = await f.phases.drive(f.phases.status(f.id).phase);
      expect(issued.record.execution?.issued).toEqual({ piece: "task-piece" });
      expect(f.plans[0]).toContain("the screens follow the phase drawing");
      expect(f.plans[0]).toContain(drawing.paths[0]);
      expect(f.plans[0]).toContain("3. Write the files this piece owns: ui/app.tsx");
      expect(f.plans[0]).toContain("4. Done when: works");
    } finally {
      if (previous === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
      else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = previous;
    }
  });

  it("[sma:px_redirect] sends a correction only to a writer that is running", async () => {
    const f = await host();
    createTask(f.db, { id: "task-r", runId: "run1", kind: "bb", contract: item().task });
    createTask(f.db, { id: "task-q", runId: "run1", kind: "bb", contract: item("q").task });
    createAttempt(f.db, { id: "att-r", runId: "run1", taskId: "task-r" });
    createAttempt(f.db, { id: "att-q", runId: "run1", taskId: "task-q" });
    f.db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='thr_w' WHERE id='att-r'").run();
    f.db.prepare("UPDATE lane_pilot_attempt SET state='queued' WHERE id='att-q'").run();
    savePhase(f.db, f.id, { stage: "execution", runId: "run1", record: { ...f.phase.record, execution: { issued: { piece: "task-r", q: "task-q" }, startedAt: 1 } } as never, at: 2 });
    const out = await f.phases.correct({ phaseId: f.id, note: "keep the blank cell" });
    expect(out.sent).toEqual(["task-r"]);
    expect(f.sent.map((row) => row.threadId)).toEqual(["thr_w"]);
    expect(f.sent[0]!.text).toContain("keep the blank cell");
  });

  it("[sma:p7_blocked] [sma:p7_recover] records a refused memory write and finishes that same lesson on a later pass", async () => {
    const previous = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
    process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = "on";
    try {
      const f = await host();
      savePhase(f.db, f.id, { stage: "lessons", record: { ...f.phases.status(f.id).phase.record, lessons: { needed: true, why: "a return" } } as never, at: 2 });
      seedRetro(f.db, "wf_read");
      const closed = f.phases.lessons({ phaseId: f.id, analysis, reviewRun: "wf_read" });
      expect(closed.record.lessons?.draft?.state).toBe("staged");
      f.db.exec("CREATE TRIGGER lp_memory_closed BEFORE INSERT ON lane_pilot_memory BEGIN SELECT RAISE(ABORT, 'memory door closed'); END");
      const refused = await f.phases.word({ phaseId: f.id, turn: "lesson", decision: "yes", text: "да", by: "owner via screen" });
      expect(refused.record.lessons?.draft).toMatchObject({ state: "staged", text: expect.stringContaining(analysis) });
      expect(refused.record.lessons?.draft?.error).toContain("memory door closed");
      expect(listParts(f.db, f.id).some((part) => part.kind === "memory_refused" && part.text.includes("memory door closed"))).toBe(true);
      f.db.exec("DROP TRIGGER lp_memory_closed");
      await f.phases.tick();
      const finished = f.phases.status(f.id).phase;
      expect(finished.record.lessons?.draft?.state).toBe("applied");
      expect(finished.record.lessons?.draft?.error).toBeUndefined();
      expect((f.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory WHERE project_id='projA'").get() as { n: number }).n).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
      else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = previous;
    }
  });

  it("issues a backend piece with its contract as the steps and without the phase drawing", () => {
    const drawing = { paths: [".agents/phases/ph/design/UI-SPEC.md"], sha256: "d", designer: "design-lead" };
    const backend = { ...item("T1"), task: { ...item("T1").task, owns_paths: ["lib/client.ts"], interfaces: ["Client.login()"], invariants: ["JWT in memory only"] } };
    const plan = piecePlan({ id: "ph", title: "Svc", record: { design: { decision: "needed", why: "screens", drawing } } } as never, backend);
    expect(plan).toContain("2. Run the checks, red before the work: npm test");
    expect(plan).toContain("with the interfaces: Client.login()");
    expect(plan).toContain("keeping the invariants: JWT in memory only");
    expect(plan).not.toContain("UI-SPEC.md");
  });
});
