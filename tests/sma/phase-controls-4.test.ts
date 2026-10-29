import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { createPhaseDriver } from "../../src/rooms/phase/server/driver";
import { nextAction, phaseFolder, planSignature, sha256, type PlanItem } from "../../src/rooms/phase/logic";
import { listParts, savePhase } from "../../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage";

const piece = (id: string): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: `then ${id}` },
  task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: "npm test" }], acceptance: ["works"] },
});

async function host() {
  const previous = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = "off";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.stop" as never, async () => ({}));
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list" as never, async () => []);
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    runGoal: { check: async () => null },
    workflowEngine: { cancel: () => true, get: () => null, start: () => ({ runId: "wf", done: Promise.resolve() }) },
    dispatchWriter: async () => ({ ok: true, taskId: "task-new", runId: "run1" }),
    readWriterWorkspaceFile: async ({ path }: { path: string }) => ({ sha256: sha256(path), sizeBytes: 40, content: `# ${path}` }),
  } as never).phases;
  const restore = () => { if (previous === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = previous; };
  return { db, phases, restore };
}

describe("phase controls", () => {
  it("[sma:p3_back_to_plan] a drawing that contradicts the plan sends the phase back to planning", async () => {
    const f = await host();
    try {
      const phase = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Draw", goal: "screens" });
      const one = piece("ui");
      const sha = planSignature([one], "ctx");
      const path = `${phaseFolder(phase.id)}/design/UI-SPEC.md`;
      savePhase(f.db, phase.id, { stage: "design", record: { ...phase.record, plan: { items: [one], sha, admittedSha: sha, contextSha: "ctx" }, design: { decision: "needed", why: "screens" } }, at: 2 });
      const back = await f.phases.drawing({ phaseId: phase.id, paths: [path], designer: "design-lead", feasible: false, contradiction: "the screen has no empty state" });
      expect(back.stage).toBe("planning");
      expect(back.record.plan?.admittedSha).toBeUndefined();
      expect(back.record.design).toBeUndefined();
      expect(listParts(f.db, phase.id).some((part) => part.kind === "return" && part.text.includes("no empty state"))).toBe(true);
    } finally { f.restore(); }
  });

  it("[sma:px_return_record] keeps the return's words and drops the acceptance it left", async () => {
    const f = await host();
    try {
      const phase = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Back", goal: "retry" });
      savePhase(f.db, phase.id, { stage: "acceptance", record: { ...phase.record, verification: { verdict: { state: "passed", detail: "ok", mainSha: null, at: 1, inputSha: "a".repeat(64) } }, acceptance: { lines: [], at: 1, accepted: false } }, at: 2 });
      expect(() => f.phases.returnTo({ phaseId: phase.id, to: "closed", note: "no" })).toThrow(/returns to/);
      expect(() => f.phases.returnTo({ phaseId: phase.id, to: "execution", note: "  " })).toThrow(/carries a note/);
      const back = f.phases.returnTo({ phaseId: phase.id, to: "execution", note: "the empty cell still fails" });
      expect(back.stage).toBe("execution");
      expect(back.record.verification).toBeUndefined();
      expect(back.record.acceptance).toBeUndefined();
      expect(listParts(f.db, phase.id).some((part) => part.kind === "return" && part.text.includes("the empty cell still fails"))).toBe(true);
    } finally { f.restore(); }
  });

  it("[sma:p4_plan_file] the admitted plan is the hash of its pieces, and a rewrite is not", async () => {
    const f = await host();
    try {
      const phase = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hash", goal: "one" });
      const one = piece("piece");
      const sha = planSignature([one], "ctx");
      savePhase(f.db, phase.id, { record: { ...phase.record, plan: { items: [one], sha, admittedSha: sha, contextSha: "ctx" } }, at: 2 });
      expect(f.phases.planUnchanged(f.phases.status(phase.id).phase)).toBe(true);
      const rewritten = piece("piece");
      rewritten.promise = { ...rewritten.promise, then: "something else" };
      savePhase(f.db, phase.id, { record: { ...f.phases.status(phase.id).phase.record, plan: { items: [rewritten], sha: planSignature([rewritten], "ctx"), admittedSha: sha, contextSha: "ctx" } }, at: 3 });
      expect(f.phases.planUnchanged(f.phases.status(phase.id).phase)).toBe(false);
    } finally { f.restore(); }
  });

  it("[sma:p2_parked] parks a blocking question on the phase and will not go on until it is answered", async () => {
    const f = await host();
    try {
      const phase = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Ask", goal: "which total" });
      const asked = f.phases.question({ phaseId: phase.id, text: "Which total?", blocking: true, by: "pm" });
      const action = nextAction(asked, new Map());
      expect(action.text).toContain("q1");
      expect(action.text).toContain("Which total?");
      expect(action.waitsForPm).toBe(true);
      expect(f.phases.status(phase.id).openQuestions.map((row) => row.id)).toEqual(["q1"]);
    } finally { f.restore(); }
  });

  it("[sma:p4_calc] reads the piece's state from its attempt, not from a claim that it finished", async () => {
    const f = await host();
    try {
      const phase = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Facts", goal: "one" });
      const one = piece("piece");
      createTask(f.db, { id: "task-piece", runId: "run1", kind: "bb", contract: one.task });
      createAttempt(f.db, { id: "att-piece", runId: "run1", taskId: "task-piece" });
      f.db.prepare("UPDATE lane_pilot_attempt SET state='running' WHERE id='att-piece'").run();
      savePhase(f.db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, plan: { items: [one], sha: "s", admittedSha: "s", contextSha: "c" }, execution: { issued: { piece: "task-piece" }, startedAt: 1, acceptedNoted: ["piece"] } }, at: 2 });
      expect(f.phases.status(phase.id).facts.piece).toMatchObject({ state: "running", planFact: null });
    } finally { f.restore(); }
  });

  it("[sma:p4_to_verify] leaves execution only once every issued piece is accepted", async () => {
    const f = await host();
    try {
      const phase = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Done", goal: "one" });
      const one = piece("piece");
      const sha = planSignature([one], "ctx");
      createTask(f.db, { id: "task-piece", runId: "run1", kind: "bb", contract: one.task });
      createAttempt(f.db, { id: "att-piece", runId: "run1", taskId: "task-piece" });
      f.db.prepare("UPDATE lane_pilot_attempt SET state='running' WHERE id='att-piece'").run();
      const record = { ...phase.record, waveReview: false, plan: { items: [one], sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: { piece: "task-piece" }, startedAt: 1 } };
      savePhase(f.db, phase.id, { stage: "execution", runId: "run1", record, at: 2 });
      expect((await f.phases.drive(f.phases.status(phase.id).phase)).stage).toBe("execution");
      f.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att-piece'").run();
      expect((await f.phases.drive(f.phases.status(phase.id).phase)).stage).toBe("verification");
    } finally { f.restore(); }
  });
});
