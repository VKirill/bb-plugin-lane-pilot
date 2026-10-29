import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { phaseToolParams } from "../src/rooms/phase/server/tool";
import { contextSignature, acceptanceLines, planSignature, type PlanItem } from "../src/rooms/phase/logic";
import { recordStage } from "../src/rooms/runs/server";
import { listParts, savePhase } from "../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../src/rooms/storage";

function driver(status = "idle") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  return Object.assign(createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined } } as unknown as Services).phases, { sent, db });
}

describe("a phase the rails opened", () => {
  it("is not closed by the PM before acceptance, and is by the owner", async () => {
    const phases = driver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module", rails: true });
    expect(phase.record.rails).toBe(true);
    expect(() => phases.setState({ phaseId: phase.id, state: "close", words: "small job", by: "pm" })).toThrow(/opened by the rails/);
    expect(phases.setState({ phaseId: phase.id, state: "close", words: "not needed", by: "owner" }).state).toBe("closed");
  });
  it("a phase the PM opened itself is closed by the PM as before", async () => {
    const phases = driver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module" });
    expect(phases.setState({ phaseId: phase.id, state: "close", words: "dropped", by: "pm" }).state).toBe("closed");
  });
});

/** A rails phase at execution with one piece «hud» in wave 1, its task accepted (or not), its plan-fact receipt failed under older rules. */
async function executing(accepted: boolean) {
  const phases = driver();
  const piece: PlanItem = { id: "hud", title: "Hud", wave: 1, promise: { given: "g", when: "w", then: "t" },
    task: { id: "hud", project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["the bar stays centred as now"] } };
  createTask(phases.db, { id: "hud", runId: "run1", kind: "bb", contract: piece.task });
  createAttempt(phases.db, { id: "att1", runId: "run1", taskId: "hud" });
  if (accepted) phases.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att1'").run();
  phases.db.prepare("UPDATE lane_pilot_run SET writer_host_id='h' WHERE id='run1'").run();
  recordStage(phases.db, { runId: "run1", taskId: "hud", stageId: "verification", state: "passed", attempt: 1, input: "v", result: { produced: ["src/hud.ts"], verification: [{ command: "npm test", exitCode: 0 }] } });
  recordStage(phases.db, { runId: "run1", taskId: "hud", stageId: "plan-fact", state: "failed", attempt: 1, input: "p", reason: "plan_fact_unproven",
    result: { table: "ok", tableReason: null, mode: "record", base: null, extraRows: [], blocking: [1], notChecked: [], items: [
      { item: 1, acceptance: "the bar stays centred as now", claimed: "done", verdict: "unproven", severity: "blocking", why: null, evidence: [{ evidence: "tests/bar_spec.ts", kind: "file", ok: false, code: "file_not_in_diff", note: "" }] }] } });
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud", rails: true });
  const items = [piece];
  const sha = planSignature(items, "ctx");
  savePhase(phases.db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, plan: { items, contextSha: "ctx", sha, admittedSha: sha, critique: { decision: "approve", by: "critic" } },
    execution: { issued: { hud: "hud" }, startedAt: 1 } } as never, at: 2 });
  return { phases, id: phase.id };
}

describe("a rails phase whose pieces are all in", () => {
  it("is closed by the PM with its words once every piece is accepted, not before", async () => {
    const open = await executing(false);
    expect(() => open.phases.setState({ phaseId: open.id, state: "close", words: "shipped", by: "pm" })).toThrow(/opened by the rails/);
    const done = await executing(true);
    expect(done.phases.setState({ phaseId: done.id, state: "close", words: "the work shipped as version 22", by: "pm" }).state).toBe("closed");
  });
  it("weighs a plan-fact verdict of older rules again, and the wave goes green without the PM (live ph_26f65b142d)", async () => {
    const { phases, id } = await executing(true);
    await phases.drive(phases.list({ live: true })[0]!);
    expect(listParts(phases.db, id).find((part) => part.kind === "plan_fact_recheck")?.text).toContain("passed");
    const wave = phases.list({ live: true }).find((row) => row.id === id)?.record.execution?.waves?.["1"];
    expect(wave?.lines.every((line) => line.ok)).toBe(true);
  });
});

describe("the driver's poke", () => {
  it("goes to an idle PM once, and waits while the PM is busy", async () => {
    const busy = driver("active");
    await busy.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module", rails: true });
    await busy.tick();
    expect(busy.sent.filter((text) => text.startsWith("[Lane Pilot phase]"))).toEqual([]);
    const idle = driver("idle");
    await idle.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module", rails: true });
    await idle.tick();
    await idle.tick();
    expect(idle.sent.filter((text) => text.startsWith("[Lane Pilot phase]"))).toHaveLength(1);
  });
  it("does not wake the PM again for a phase that has stalled: the aging goes to the book only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const phases = driver("idle");
      const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module", rails: true });
      await phases.tick();
      vi.setSystemTime(Date.now() + 4 * 86_400_000);
      await phases.tick();
      vi.setSystemTime(Date.now() + 2 * 86_400_000);
      await phases.tick();
      expect(phases.sent.filter((text) => text.startsWith("[Lane Pilot phase]"))).toHaveLength(1);
      expect(phases.sent.some((text) => text.includes("has not moved"))).toBe(false);
      expect(listParts(phases.db, phase.id).filter((part) => part.kind === "aging").length).toBeGreaterThanOrEqual(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("the phase tool takes JSON text for its lists and objects", () => {
  it("parses a context report sent as text, as a live PM sent it", () => {
    const parsed = phaseToolParams.parse({ action: "context", phaseId: "ph_1", docs: "[\".agents/phases/ph_1/CONTEXT.md\"]",
      risks: "{\"value\":\"v\",\"usability\":\"u\",\"feasibility\":\"f\",\"viability\":\"b\"}", appetite: "one day", noGos: "[\"no new screens\"]", decisions: "[\"D1\"]" });
    expect(parsed).toMatchObject({ docs: [".agents/phases/ph_1/CONTEXT.md"], risks: { value: "v" }, noGos: ["no new screens"], decisions: ["D1"] });
  });
  it("still refuses text that is not JSON of the field's type, and takes a rubric by phaseId", () => {
    expect(phaseToolParams.safeParse({ action: "context", phaseId: "ph_1", docs: "CONTEXT.md", risks: {} }).success).toBe(false);
    expect(phaseToolParams.safeParse({ action: "rubric", phaseId: "ph_1" }).success).toBe(true);
  });
});

/** A finished lp.plan run in the journal: [node, role, thread, started, ended] per agent step. */
function seedPlanRun(db: ReturnType<typeof openDatabase>, id: string, steps: Array<[string, string, string, number, number]>,
  run: { projectId?: string; output?: Record<string, unknown>; createdAt?: number } = {}) {
  const nodes = steps.map(([node, role]) => ({ id: node, type: "agent", role }));
  // The run is the phase project's, made after the plan was submitted, and its critic's own output passed the plan (unless a test says otherwise).
  const createdAt = run.createdAt ?? Date.now() + 60_000;
  db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, "lp.plan", 1, "sha", JSON.stringify({ id: "lp.plan", nodes }), run.projectId ?? "projA", "succeeded", JSON.stringify(run.output ?? { status: "ok", plan_verdict: "pass" }), createdAt, createdAt);
  steps.forEach(([node, , thread, started, ended], index) => db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, `${node}#${index + 1}`, `${node}#${index + 1}`, node, index + 1, "succeeded", JSON.stringify({ threadId: thread }), started, ended, ended));
}

describe("the plan checker is proven independent by the run journal, never by a name", () => {
  async function planned() {
    const phases = driver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module" });
    const risks = { technical: "none", product: "none", operations: "none", security: "none" };
    savePhase(phases.db, phase.id, { stage: "planning", record: { context: { docs: [], sha: contextSignature([]), signedAt: 1, risks, requirements: ["R1"] } }, at: 1 });
    phases.plan({ phaseId: phase.id, items: [], alreadyMet: "the planner checked the repository: stats already exist", by: "lp.plan" });
    return { phases, phase };
  }

  it("refuses an approval that names no run, or a run whose critic was skipped [sma:p2_checker]", async () => {
    const { phases, phase } = await planned();
    await expect(phases.planCheck({ phaseId: phase.id, decision: "approve", by: "lp.plan, plan critic" })).rejects.toMatchObject({ why: [expect.stringMatching(/not proven independent: it names no workflow run/)] });
    seedPlanRun(phases.db, "wfrun_small", [["plan", "planner", "thr_planner", 10, 20]]);
    await expect(phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic", wfRunId: "wfrun_small" })).rejects.toMatchObject({ why: [expect.stringMatching(/no plan-critic session finished/)] });
  });

  it("refuses a critic that went on in the planner's session or in the PM's [sma:p2_checker]", async () => {
    const { phases, phase } = await planned();
    seedPlanRun(phases.db, "wfrun_same", [["plan", "planner", "thr_planner", 10, 20], ["plan_critic", "plan-critic", "thr_planner", 30, 40]]);
    await expect(phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic", wfRunId: "wfrun_same" })).rejects.toMatchObject({ why: [expect.stringMatching(/went on in the planner's session/)] });
    seedPlanRun(phases.db, "wfrun_pm", [["plan_critic", "plan-critic", "thr_pm", 30, 40]]);
    await expect(phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic", wfRunId: "wfrun_pm" })).rejects.toMatchObject({ why: [expect.stringMatching(/went on in the planner's session thr_pm/)] });
  });

  it("refuses a critic that started before the planner was done [sma:p2_order]", async () => {
    const { phases, phase } = await planned();
    seedPlanRun(phases.db, "wfrun_early", [["plan", "planner", "thr_planner", 10, 50], ["plan_critic", "plan-critic", "thr_critic", 30, 60]]);
    await expect(phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic", wfRunId: "wfrun_early" })).rejects.toMatchObject({ why: [expect.stringMatching(/started before the plan was done/)] });
  });

  // SMA audit N-03: any journal with a finished critic admitted the plan — another project's old run, and one whose critic asked for changes.
  it("refuses a run of another project, one made before the plan, and an approval its critic's own output does not give [sma:p2_checker]", async () => {
    const { phases, phase } = await planned();
    const steps: Array<[string, string, string, number, number]> = [["plan", "planner", "thr_planner", 10, 20], ["plan_critic", "plan-critic", "thr_critic", 30, 40]];
    seedPlanRun(phases.db, "wfrun_other", steps, { projectId: "OTHER" });
    await expect(phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic", wfRunId: "wfrun_other" })).rejects.toMatchObject({ why: [expect.stringMatching(/belongs to project OTHER/)] });
    seedPlanRun(phases.db, "wfrun_old", steps, { createdAt: 1 });
    await expect(phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic", wfRunId: "wfrun_old" })).rejects.toMatchObject({ why: [expect.stringMatching(/did not check this plan/)] });
    seedPlanRun(phases.db, "wfrun_no", steps, { output: { status: "fail", plan_verdict: "changes_requested" } });
    await expect(phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic", wfRunId: "wfrun_no" })).rejects.toMatchObject({ why: [expect.stringMatching(/did not approve: its output says changes_requested/)] });
    expect(phases.status(phase.id).phase.stage).toBe("planning");
  });

  it("refuses a plan the planner rewrote after the check, and admits the one the critic had the last word on [sma:p2_session_end]", async () => {
    const { phases, phase } = await planned();
    seedPlanRun(phases.db, "wfrun_after", [["plan", "planner", "thr_planner", 10, 20], ["plan_critic", "plan-critic", "thr_critic", 30, 40], ["plan", "planner", "thr_planner", 50, 60]]);
    await expect(phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic", wfRunId: "wfrun_after" })).rejects.toMatchObject({ why: [expect.stringMatching(/wrote again after the check/)] });
    seedPlanRun(phases.db, "wfrun_rework", [["plan", "planner", "thr_planner", 10, 20], ["plan_critic", "plan-critic", "thr_critic", 30, 40], ["plan", "planner", "thr_planner", 50, 60], ["plan_critic", "plan-critic", "thr_critic2", 70, 80]]);
    const admitted = await phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic", wfRunId: "wfrun_rework" });
    expect(admitted.stage).toBe("execution");
    expect(admitted.record.plan!.critique!.independence).toMatchObject({ ok: true, checker: "thr_critic2", planners: ["thr_planner", "thr_pm"], checkerStartedAt: 70, plannedUntil: 60 });
  });
});

// Review 2026-10-26 §1: lp.plan may return already_met with no tasks; the phase refused that and demanded work again.
describe("a plan that found the goal already met", () => {
  it("is admitted without pieces, skips execution, and reaches the goal audit with the planner's evidence", async () => {
    const phases = driver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module" });
    const risks = { technical: "none", product: "none", operations: "none", security: "none" };
    savePhase(phases.db, phase.id, { stage: "planning", record: { context: { docs: [], sha: contextSignature([]), signedAt: 1, risks, requirements: ["R1"] } }, at: 1 });
    phases.plan({ phaseId: phase.id, items: [], alreadyMet: "the planner checked the repository: stats already exist", by: "lp.plan" });
    seedPlanRun(phases.db, "wfrun_plan", [["plan", "planner", "thr_planner", 10, 20], ["plan_critic", "plan-critic", "thr_critic", 30, 40]]);
    const admitted = await phases.planCheck({ phaseId: phase.id, decision: "approve", by: "lp.plan, plan critic", wfRunId: "wfrun_plan" });
    expect(admitted.stage).toBe("execution");
    expect(admitted.record.plan).toMatchObject({ items: [], alreadyMet: { evidence: expect.stringContaining("stats already exist") } });
    expect(admitted.record.plan!.admittedSha).toBe(admitted.record.plan!.sha);
    // Execution has nothing to issue; the next pass leaves it, and the verification stage freezes the claim as its verdict.
    let now = await phases.drive(admitted);
    now = await phases.drive(now);
    expect(now.stage).toBe("verification");
    expect(now.record.verification?.verdict).toMatchObject({ state: "passed", detail: expect.stringContaining("already met") });
    const lines = acceptanceLines(now, new Map(), { mainSha: null, openDeferrals: 0 });
    // Everything that needs a piece holds vacuously; the goal audit is what is still owed.
    expect(lines.filter((line) => !line.ok).map((line) => line.id)).toEqual(["goal_met"]);
  });

  it("an empty plan without already_met is still refused by the plan gate", async () => {
    const phases = driver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module" });
    const risks = { technical: "none", product: "none", operations: "none", security: "none" };
    savePhase(phases.db, phase.id, { stage: "planning", record: { context: { docs: [], sha: contextSignature([]), signedAt: 1, risks } }, at: 1 });
    phases.plan({ phaseId: phase.id, items: [], by: "lp.plan" });
    await expect(phases.planCheck({ phaseId: phase.id, decision: "approve", by: "critic" })).rejects.toThrow(/not admitted/);
  });
});
