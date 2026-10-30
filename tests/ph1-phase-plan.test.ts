import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { type Phase, type PhaseRecord } from "../src/rooms/phase/logic";
import { autoDue, autoInputs, createAutoStages } from "../src/rooms/phase/server/auto-stages";
import { phaseToolParams } from "../src/rooms/phase/server/tool";
import { openDatabase } from "../src/rooms/storage";
import { savePhase } from "../src/rooms/phase/store";

// PH1: the plan a PM of ph_f16b2b8b06 sent four times and got only «items: Invalid input» — covers inside the task, no project_cwd.
const taskV2 = { schema_version: 2 as const, id: "t1", title: "T", risk: "low" as const, lane: "core", project_cwd: "/repo",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["f"], owns_paths: ["src/**"], never_touch: [],
  depends_on: [], objective: "o", acceptance: ["a"], verify: "none" as const, verification: [] };
const planItem = { id: "t1", title: "T", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: taskV2 };

describe("the plan tool's input", () => {
  it("names the field that failed, not «Invalid input»", () => {
    const bad = { ...planItem, task: { ...taskV2, objective: undefined } };
    const parsed = phaseToolParams.safeParse({ action: "plan", phaseId: "ph_x", items: [bad] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.path.join(".")).join(",")).toContain("task.objective");
    // The same object as JSON text parses too, with the same named error on a bad field.
    expect(phaseToolParams.safeParse({ action: "plan", phaseId: "ph_x", items: JSON.stringify([planItem]) }).success).toBe(true);
  });

  it("lifts task.covers to the item and lets project_cwd fall back to the phase's checkout", () => {
    const { project_cwd: _cwd, ...taskNoCwd } = taskV2;
    const parsed = phaseToolParams.safeParse({ action: "plan", phaseId: "ph_x", items: [{ ...planItem, task: { ...taskNoCwd, covers: ["R1", "D2"] } }] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const item = (parsed.data as { items: unknown[] }).items[0] as { covers?: string[]; task: { covers?: unknown } };
      expect(item.covers).toEqual(["R1", "D2"]);
      expect(item.task.covers).toBeUndefined();
    }
  });
});

const planning = (record: PhaseRecord): Phase => ({ id: "ph_1", projectId: "p", pmThreadId: "thr_pm", runId: "r", title: "t", goal: "g",
  stage: "planning", state: "active", record, edition: 1, createdAt: 0, updatedAt: 0 }) as Phase;
const withPlan = (extra: PhaseRecord = {}) => planning({ context: { docs: [], sha: "ctx", signedAt: 1 }, plan: { items: [], sha: "plansha", contextSha: "ctx", submittedAt: 1 }, ...extra });

describe("a plan the PM submitted", () => {
  it("is checked by the machine itself: lp.plan due with the plan's sha, the PM starts nothing", () => {
    expect(autoDue(withPlan())).toEqual({ kind: "check" });
    expect(autoInputs(withPlan(), { kind: "check" }).plan_sha).toBe("plansha");
    // An admitted plan schedules nothing.
    expect(autoDue(withPlan({ plan: { items: [], sha: "s", contextSha: "ctx", admittedSha: "s", critique: { decision: "approve", by: "c" } } } as never))).toBeNull();
  });

  it("reports the check run's verdict through the gates without touching the PM's plan", async () => {
    let phase = withPlan({ auto: { kind: "check", wfRunId: "wfrun_1", startedAt: 1 } });
    const calls: string[] = [];
    const auto = createAutoStages({ log: () => undefined }, { workflowEngine: { get: () => ({ runId: "wfrun_1", status: "succeeded", output: { status: "ok", plan_verdict: "pass" } }) } as never }, {
      api: { planCheck: async (input: { decision: string; wfRunId?: string }) => { calls.push(`planCheck ${input.decision} ${input.wfRunId}`); return phase; } },
      get: () => phase, save: (_id: string, record: typeof phase.record) => { phase = { ...phase, record }; }, book: () => undefined,
      now: () => 1, runStopped: async () => false,
    } as never);
    expect(await auto.step(phase)).toBe(true);
    expect(calls).toEqual(["planCheck approve wfrun_1"]);
    expect(phase.record.plan!.items).toEqual([]);
  });

  it("«changed after the signature» sends the phase to resign, not to the spent loop", async () => {
    let phase = withPlan({ auto: { kind: "plan", wfRunId: "wfrun_1", startedAt: 1 } });
    const calls: string[] = [];
    const auto = createAutoStages({ log: () => undefined }, { workflowEngine: { get: () => ({ runId: "wfrun_1", status: "succeeded", output: { status: "ok", tasks: [{ id: "x" }], waves: [], plan_verdict: "pass" } }) } as never }, {
      api: {
        plan: () => { throw Object.assign(new Error("docs/CONTEXT.md changed after the context was signed: return the phase to discussion and sign it again"), { why: [] }); },
        planCheck: async () => phase,
        returnTo: (input: { to: string }) => { calls.push(`return ${input.to}`); phase = { ...phase, stage: "discussion", record: { ...phase.record, signedBefore: { docs: ["docs/CONTEXT.md"] }, context: undefined } }; return phase; },
      },
      get: () => phase, save: (_id: string, record: typeof phase.record) => { phase = { ...phase, record }; }, book: () => undefined,
      now: () => 1, runStopped: async () => false,
    } as never);
    expect(await auto.step(phase)).toBe(true);
    expect(calls).toEqual(["return discussion"]);
    expect(phase.record.autoFailures).toBeUndefined();
    // …and the resign is the next thing the machine does.
    expect(autoDue(phase)).toEqual({ kind: "resign" });
  });
});

describe("a new context signature", () => {
  it("forgets the plan tries spent against the old documents", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const phases = createPhaseDriver(createCore(bb, db), { readWriterWorkspaceFile: async () => ({ sha256: "b".repeat(64), sizeBytes: 10 }) } as never).phases;
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "t", goal: "g" });
    const risks = { value: "v", usability: "u", feasibility: "f", viability: "x" };
    const input = { docs: ["docs/CONTEXT.md"], risks, appetite: "an hour", noGos: ["none"], by: "pm" };
    // Tries spent planning on the old context, the phase back at discussion to sign again.
    savePhase(db, phase.id, { stage: "discussion", record: { ...phases.status(phase.id).phase.record, autoFailures: { plan: 2 }, autoFailuresTotal: { plan: 2 } }, at: 2 });
    expect(autoDue({ ...phases.status(phase.id).phase, record: { ...phases.status(phase.id).phase.record, context: { docs: [], sha: "old", signedAt: 1 } } })).toBeNull();
    await phases.context({ phaseId: phase.id, ...input });
    const after = phases.status(phase.id).phase;
    expect(after.record.autoFailures).toBeUndefined();
    expect(after.record.autoFailuresTotal).toBeUndefined();
    // …and with the tries forgotten the machine plans again.
    expect(autoDue(after)).toEqual({ kind: "plan" });
  });
});
