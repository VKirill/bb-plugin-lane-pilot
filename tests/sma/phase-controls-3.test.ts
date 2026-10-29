import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { costPerVerified } from "../../src/rooms/self-improve";
import { createPhaseDriver } from "../../src/rooms/phase/server/driver";
import { contextSignature, nextAction, phaseFolder, planSignature, sha256, type PlanItem } from "../../src/rooms/phase/logic";
import { listParts, savePhase } from "../../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage";

const piece = (id: string, owns: string[]): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: `then ${id}` },
  task: { id, owns_paths: owns, verification: [{ command: "npm test" }], acceptance: ["works"] },
});

async function host(ownerWords: "on" | "off" = "off") {
  const previous = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = ownerWords;
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const plans: string[] = [];
  harness.sdk.stub("threads.stop" as never, async () => ({}));
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list" as never, async () => []);
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  const files = new Map<string, { sha256: string; sizeBytes: number }>();
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    workflowEngine: { cancel: () => true, get: () => null, start: () => ({ runId: "wf", done: Promise.resolve() }) },
    dispatchWriter: async (input: { plan?: string }) => { plans.push(input.plan ?? ""); return { ok: true, taskId: "task-new", runId: "run1" }; },
    readWriterWorkspaceFile: async ({ path }: { path: string }) => files.get(path) ?? { sha256: sha256(path), sizeBytes: 40, content: `# ${path}` },
  } as never).phases;
  const restore = () => { if (previous === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = previous; };
  return { db, phases, plans, files, restore };
}

function seedPlanRun(db: ReturnType<typeof openDatabase>, id: string, planSha: string) {
  const nodes = [{ id: "plan", type: "agent", role: "planner" }, { id: "plan_critic", type: "agent", role: "plan-critic" }];
  const createdAt = Date.now() + 60_000;
  db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "lp.plan", 1, "sha", JSON.stringify({ id: "lp.plan", nodes }), "projA", "succeeded", JSON.stringify({ plan_sha: planSha }), JSON.stringify({ status: "ok", plan_verdict: "pass" }), createdAt, createdAt);
  const steps: Array<[string, string, number, number]> = [["plan", "thr_planner", 10, 20], ["plan_critic", "thr_critic", 30, 40]];
  steps.forEach(([node, thread, started, ended], index) => db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, `${node}#${index + 1}`, `${node}#${index + 1}`, node, index + 1, "succeeded", JSON.stringify({ threadId: thread }), started, ended, ended));
}

const risks = { value: "none", usability: "none", feasibility: "none", viability: "none" };

describe("phase controls", () => {
  it("[sma:p1_start] creates a phase control work, and a second open is a new one", async () => {
    const f = await host();
    try {
      const first = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "skip blanks" });
      const second = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Other", goal: "other" });
      expect(first.id).not.toBe(second.id);
      expect(first.stage).toBe("discussion");
      expect(first.goal).toBe("skip blanks");
      expect(listParts(f.db, first.id).some((part) => part.kind === "opened" && part.text.includes("Sums"))).toBe(true);
    } finally { f.restore(); }
  });

  it("[sma:p1_signed] [sma:p1_book_ready] puts the signed edition in the book before planning, and holds it when the owner must sign", async () => {
    const off = await host("off");
    try {
      const phase = await off.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "skip blanks" });
      const moved = await off.phases.context({ phaseId: phase.id, docs: ["docs/CONTEXT.md"], risks, appetite: "one day", noGos: ["none"] });
      expect(moved.stage).toBe("planning");
      expect(moved.record.context?.sha).toBe(contextSignature(moved.record.context!.docs));
      const parts = listParts(off.db, phase.id);
      const signed = parts.find((part) => part.kind === "signed");
      const stage = parts.find((part) => part.kind === "stage" && part.text.includes("planning"));
      expect(signed?.text).toContain(moved.record.context!.sha.slice(0, 12));
      expect(signed && stage && signed.seq < stage.seq).toBe(true);
    } finally { off.restore(); }
    const on = await host("on");
    try {
      const phase = await on.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "skip blanks" });
      const held = await on.phases.context({ phaseId: phase.id, docs: ["docs/CONTEXT.md"], risks, appetite: "one day", noGos: ["none"] });
      expect(held.stage).toBe("discussion");
      expect(held.record.context?.sha).toBe(contextSignature(held.record.context!.docs));
      expect(listParts(on.db, phase.id).some((part) => part.kind === "awaits_signature")).toBe(true);
    } finally { on.restore(); }
  });

  it("[sma:p2_legacy] queues a plan that has no signed discussion and does not hand it in", async () => {
    const f = await host();
    try {
      const phase = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Old", goal: "already planned", legacy: true });
      expect(phase.stage).toBe("planning");
      expect(phase.record.context).toMatchObject({ legacy: true, docs: [] });
      const queued = f.phases.plan({ phaseId: phase.id, items: [piece("a", ["src/a.ts"])], by: "pm" });
      expect(queued.stage).toBe("planning");
      expect(queued.record.plan?.admittedSha).toBeUndefined();
      expect(queued.record.plan?.items).toHaveLength(1);
      await expect(f.phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic" })).rejects.toThrow(/not admitted|not proven independent/);
      expect(f.phases.status(phase.id).phase.stage).toBe("planning");
    } finally { f.restore(); }
  });

  it("[sma:p2_planning] [sma:p3_needs_plan] admits the checked edition, and a screen piece waits for a drawing", async () => {
    const f = await host();
    try {
      const screen = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Screens", goal: "a screen" });
      const docs = [{ path: "docs/CONTEXT.md", sha256: sha256("docs/CONTEXT.md"), bytes: 40 }];
      savePhase(f.db, screen.id, { stage: "planning", record: { ...screen.record, context: { docs, sha: contextSignature(docs), signedAt: 1, risks } }, at: 2 });
      f.phases.plan({ phaseId: screen.id, items: [piece("ui", ["src/App.tsx"])], by: "planner" });
      const sha = f.phases.status(screen.id).phase.record.plan!.sha;
      seedPlanRun(f.db, "wf_screen", sha);
      const admitted = await f.phases.planCheck({ phaseId: screen.id, decision: "approve", by: "critic", wfRunId: "wf_screen" });
      expect(admitted.stage).toBe("design");
      expect(admitted.record.plan?.admittedSha).toBe(sha);
      expect(admitted.record.design?.decision).toBe("needed");
      const plain = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Logic", goal: "no screen" });
      savePhase(f.db, plain.id, { stage: "planning", record: { ...plain.record, context: { docs, sha: contextSignature(docs), signedAt: 1, risks } }, at: 2 });
      f.phases.plan({ phaseId: plain.id, items: [piece("a", ["src/a.ts"])], by: "planner" });
      const plainSha = f.phases.status(plain.id).phase.record.plan!.sha;
      seedPlanRun(f.db, "wf_plain", plainSha);
      const moved = await f.phases.planCheck({ phaseId: plain.id, decision: "approve", by: "critic", wfRunId: "wf_plain" });
      expect(moved.stage).toBe("execution");
      expect(listParts(f.db, plain.id).some((part) => part.kind === "admitted" && part.text.includes(plainSha.slice(0, 12)))).toBe(true);
    } finally { f.restore(); }
  });

  it("[sma:p3_advance] [sma:p3_confirmed] keeps the previous drawing and confirms only a reviewed feasible one", async () => {
    const f = await host();
    try {
      const phase = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Draw", goal: "screens" });
      const folder = `${phaseFolder(phase.id)}/design/`;
      savePhase(f.db, phase.id, { stage: "design", record: { ...phase.record, design: { decision: "needed", why: "screens" } }, at: 2 });
      const path = `${folder}UI-SPEC.md`;
      f.files.set(path, { sha256: "a".repeat(64), sizeBytes: 20 });
      await expect(f.phases.drawing({ phaseId: phase.id, paths: [path], designer: "design-lead", feasible: true })).rejects.toThrow(/not confirmed/);
      expect(f.phases.status(phase.id).phase.stage).toBe("design");
      f.files.set(path, { sha256: "b".repeat(64), sizeBytes: 20 });
      const confirmed = await f.phases.drawing({ phaseId: phase.id, paths: [path], designer: "design-lead", feasible: true, reviewer: "ui-review" });
      expect(confirmed.stage).toBe("execution");
      expect(confirmed.record.design?.confirmedAt).toEqual(expect.any(Number));
      expect(confirmed.record.design?.archived).toHaveLength(1);
      expect(confirmed.record.design?.archived?.[0]?.sha256).not.toBe(confirmed.record.design?.drawing?.sha256);
    } finally { f.restore(); }
  });

  it("[sma:p4_result] writes an accepted piece into the phase book with its promise", async () => {
    const f = await host();
    try {
      const phase = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Run", goal: "one piece" });
      const one = piece("piece", ["src/a.ts"]);
      const sha = planSignature([one], "ctx");
      createTask(f.db, { id: "task-piece", runId: "run1", kind: "bb", contract: one.task });
      createAttempt(f.db, { id: "att-piece", runId: "run1", taskId: "task-piece" });
      f.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att-piece'").run();
      savePhase(f.db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, plan: { items: [one], sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: { piece: "task-piece" }, startedAt: 1 } }, at: 2 });
      const after = await f.phases.drive(f.phases.status(phase.id).phase);
      expect(listParts(f.db, phase.id).some((part) => part.kind === "accepted" && part.text.includes("then piece"))).toBe(true);
      expect(after.record.execution?.acceptedNoted).toEqual(["piece"]);
      expect(f.plans).toEqual([]);
    } finally { f.restore(); }
  });

  it("[sma:px_requested] [sma:px_paused] writes pause before any issue, and a requested pause becomes paused", async () => {
    const f = await host();
    try {
      const phase = await f.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hold", goal: "wait" });
      const one = piece("piece", ["src/a.ts"]);
      const sha = planSignature([one], "ctx");
      savePhase(f.db, phase.id, { stage: "execution", state: "pause_requested", record: { ...phase.record, plan: { items: [one], sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: {}, startedAt: 1 } }, at: 2 });
      const asked = f.phases.status(phase.id).phase;
      expect(nextAction(asked, new Map()).text).toContain("is paused");
      const out = await f.phases.drive(asked);
      expect(out.state).toBe("paused");
      expect(out.record.execution?.issued).toEqual({});
      expect(f.plans).toEqual([]);
    } finally { f.restore(); }
  });

  it("[sma:k_lib_northstar] divides a project's tokens by the results it verified, and leaves the number empty when none were", async () => {
    const f = await host();
    try {
      const day = new Date().toISOString().slice(0, 10);
      f.db.prepare("INSERT INTO lane_pilot_token_daily(day,project_id,provider_id,model,total_tokens) VALUES (?,?,?,?,?)").run(day, "projA", "p", "m", 200);
      f.db.prepare("INSERT INTO lane_pilot_token_daily(day,project_id,provider_id,model,total_tokens) VALUES (?,?,?,?,?)").run(day, "projB", "p", "m", 50);
      createTask(f.db, { id: "task-ok", runId: "run1", kind: "bb", contract: { id: "task-ok" } });
      createAttempt(f.db, { id: "att-ok", runId: "run1", taskId: "task-ok" });
      f.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att-ok'").run();
      const rows = costPerVerified(f.db);
      expect(rows.find((row) => row.projectId === "projA")).toMatchObject({ tokens: 200, accepted: 1, tokensPerAccepted: 200 });
      expect(rows.find((row) => row.projectId === "projB")).toMatchObject({ tokens: 50, accepted: 0, tokensPerAccepted: null });
    } finally { f.restore(); }
  });
});
