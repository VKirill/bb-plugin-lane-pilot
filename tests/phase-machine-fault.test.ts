import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { MACHINE_STAGE_FAILURE, autoDue, contextDoc, createAutoStages, recoverStopped } from "../src/rooms/phase/server/auto-stages";
import { planGate, type Phase, type PhaseRecord } from "../src/rooms/phase/logic";
import { threatGap } from "../src/rooms/phase/stages";
import { listParts, savePhase } from "../src/rooms/phase/store";
import { createRun, openDatabase, setRunThread } from "../src/rooms/storage";

/**
 * Fable's recheck of 0.1.341 (R1), built from the real data of the drill phase ph_5cd09d1c7a (hub, 2026-10-27 00:06 UTC, Lane Pilot 0.1.336):
 * lp.analyze named a «security» risk, no document carried the threat model, the plan gate refused an approved plan twice ("the plan is not admitted"),
 * the loop was counted as the product's, the phase was stopped (empty scope) and nothing resumed it after the release that fixed the cause.
 */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/phase-ph_5cd09d1c7a-${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
const STOPPED = fixture("record") as unknown as PhaseRecord;
const ANALYSIS = fixture("analyze");
const whyOf = (record: PhaseRecord) => { const gate = planGate(record); return gate.ok ? [] : gate.why; };
const FOLDER = ".agents/phases/ph_5cd09d1c7a";

const phaseOf = (stage: string, state: string, record: PhaseRecord): Phase => ({ id: "ph_5cd09d1c7a", projectId: "p", pmThreadId: "thr_pm", runId: "run1", title: "Drill route", goal: "a drill file",
  stage, state, record, edition: 1, createdAt: 1, updatedAt: 1 }) as unknown as Phase;
/** The phase as it stood when the plan gate refused the approved plan the second time, before the machine ended the loop. */
const refused = (): Phase => phaseOf("planning", "active", { ...STOPPED, closing: undefined, scope: undefined, auto: undefined, autoFailures: { plan: 1 }, autoFailuresTotal: undefined, lessons: undefined });

type Run = { status: string; output: Record<string, unknown> | null; error?: string };

function world(start: Phase, over: { runs?: Map<string, Run>; refusal?: Error; writes?: boolean } = {}) {
  let phase = start;
  const calls: string[] = [];
  const written: string[] = [];
  const runs = over.runs ?? new Map<string, Run>();
  const auto = createAutoStages({ log: () => undefined }, {
    workflowEngine: { start: (input: { workflow: { id: string } }) => { calls.push(`start ${input.workflow.id}`); runs.set("wfrun_1", { status: "running", output: null }); return { runId: "wfrun_1", created: true, done: new Promise(() => undefined) }; },
      get: (runId: string) => ({ runId, reason: null, error: null, failedNode: null, waiting: [], stopped: false, ...runs.get(runId)! }) } as never,
  }, {
    exhausted: async () => { calls.push("exhausted"); },
    api: {
      context: async (input) => { calls.push(`context ${input.docs.map((path) => path.split("/").at(-1)).join(",")}`); phase = phaseOf("planning", "active", { ...phase.record, signedBefore: undefined, context: { ...(STOPPED.context!), docs: input.docs.map((path) => ({ path, sha256: "s", bytes: 1 })) } }); return phase; },
      plan: () => phase, planCheck: async () => { calls.push("planCheck"); if (over.refusal) throw over.refusal; return phase; }, question: () => phase, waveReview: () => phase, goalAudit: () => phase, lessons: () => phase, drawing: async () => phase,
      returnTo: (input) => { calls.push(`return ${input.to}`); const { context, ...rest } = phase.record; phase = phaseOf(input.to, "active", { ...rest, signedBefore: { docs: context!.docs.map((doc) => doc.path), risks: context!.risks } }); return phase; },
    },
    get: () => phase, save: (_id, record) => { phase = { ...phase, record }; },
    book: (_phase, _section, kind) => { calls.push(`book ${kind}`); },
    writeDocs: async (_phase, files) => { for (const file of files) written.push(file.path); return { written: over.writes === false ? [] : files.map((file) => file.path) }; },
    runtime: () => ({}), bookHead: () => "h", pmIdle: async () => true, now: () => 1, version: "0.1.341",
  });
  return { auto, calls, written, runs, get: () => phase };
}

describe("R1: the drill phase's own data", () => {
  it("the real analysis output names the security risk that needs a threat model, and the analysis writes and signs it (0.1.337)", () => {
    const doc = contextDoc(phaseOf("discussion", "active", {}), ANALYSIS);
    expect(doc.security).toMatch(/write permission for a new top-level directory/);
    const docs = [{ path: `${FOLDER}/CONTEXT.md` }, { path: `${FOLDER}/SECURITY.md` }];
    expect(threatGap({ context: { docs, risks: doc.risks } } as never)).toBeNull();
    // What the hub holds: the context of the drill was signed under 0.1.336 with CONTEXT.md alone, so the gate refused its plan for the threat model only.
    expect(whyOf(refused().record)).toEqual([expect.stringMatching(/needs a threat model/)]);
  });

  it("a gate refusal that only asks for the threat model is the machine's gap, never the product's loop", async () => {
    const why = whyOf(refused().record);
    expect(MACHINE_STAGE_FAILURE.test(`the plan is not admitted: ${why.join("; ")}`)).toBe(true);
    expect(MACHINE_STAGE_FAILURE.test("the plan is not admitted: no independent plan check")).toBe(false);
    const runs = new Map<string, Run>([["wfrun_1", { status: "succeeded", output: { status: "ok", tasks: [{ id: "route", title: "t", acceptance: ["a"] }], waves: [["route"]], plan_verdict: "approve" } }]]);
    const start = refused();
    const w = world({ ...start, record: { ...start.record, auto: { kind: "plan", wfRunId: "wfrun_1", startedAt: 1 }, autoFailures: { plan: 1 } } } as Phase, { runs, refusal: Object.assign(new Error("the plan is not admitted"), { why }) });
    await w.auto.step(w.get());
    expect(w.calls).not.toContain("exhausted");
    expect(w.get().record.autoFailuresTotal).toBeUndefined();
  });

  it("a document the machine could not write is its own fault, not the work's", () => {
    for (const why of ["CONTEXT.md was not written", "SECURITY.md was not written"]) expect(MACHINE_STAGE_FAILURE.test(why), why).toBe(true);
  });

  it("a context signed without the threat model gets SECURITY.md from the machine, is signed again with it, and the plan is made anew", async () => {
    const w = world(refused());
    expect(autoDue(w.get())).toEqual({ kind: "plan" });
    await w.auto.step(w.get());
    expect(w.calls).not.toContain("start lp.plan");
    expect(w.written).toEqual([`${FOLDER}/SECURITY.md`]);
    expect(w.calls).toContain("return discussion");
    expect(w.get().record.plan).toBeUndefined();
    expect(autoDue(w.get())).toEqual({ kind: "resign" });
    await w.auto.step(w.get());
    expect(w.calls).toContain("context CONTEXT.md,SECURITY.md");
    expect(threatGap(w.get().record)).toBeNull();
    expect(autoDue(w.get())).toEqual({ kind: "plan" });
  });

  it("when SECURITY.md cannot be written the stage waits for a release without counting a try of the loop", async () => {
    const w = world(refused(), { writes: false });
    await w.auto.step(w.get());
    expect(w.calls).not.toContain("exhausted");
    expect(w.calls).not.toContain("return discussion");
    expect(w.get().record.autoFailuresTotal).toBeUndefined();
  });
});

describe("R1: a phase stopped by Lane Pilot's own gap resumes after the release", () => {
  const stopped = () => phaseOf("planning", "stopped", { ...STOPPED });
  it("is recovered from the real record: scope restored, the closing and the lessons mark dropped, the tries forgotten", () => {
    const back = recoverStopped(stopped(), "0.1.341");
    expect(back).not.toBeNull();
    expect(back!.record.scope?.withdrawn).toEqual([]);
    expect(back!.record.closing).toBeUndefined();
    expect(back!.record.autoFailures).toBeUndefined();
    expect(back!.record.plan?.items).toHaveLength(1);
  });
  it("is left alone when the stop was a person's, the release is the same one, or the plan is refused for a reason of the work", () => {
    expect(recoverStopped(stopped(), "0.1.336")).toBeNull();
    expect(recoverStopped(phaseOf("planning", "stopped", { ...STOPPED, closing: { by: "pm", words: "stop", at: 1 } }), "0.1.341")).toBeNull();
    expect(recoverStopped(phaseOf("planning", "stopped", { ...STOPPED, plan: { ...STOPPED.plan!, critique: undefined } }), "0.1.341")).toBeNull();
    expect(recoverStopped(phaseOf("planning", "paused", { ...STOPPED }), "0.1.341")).toBeNull();
  });

  it("the real driver's tick puts the stopped drill phase back to work and books why", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.send", async () => ({}));
    harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
    harness.sdk.stub("threads.list", async () => []);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    setRunThread(db, "run1", "thr_pm");
    const services = { rollback: {}, workflowEngine: { start: () => ({ runId: "wf1", created: true, done: new Promise(() => undefined) }), get: () => null } } as unknown as Services;
    const phases = createPhaseDriver(createCore(bb, db), services).phases;
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Drill route", goal: "a drill file" });
    savePhase(db, phase.id, { stage: "planning", state: "stopped", record: STOPPED, runId: "run1", at: 1 });
    await phases.tick();
    const after = phases.list({ limit: 5 }).find((row) => row.id === phase.id)!;
    expect(after.state).toBe("active");
    expect(after.record.scope?.withdrawn).toEqual([]);
    expect(listParts(db, phase.id).map((part) => part.kind)).toContain("resume_after_fix");
    // Not again: a second tick does not book the resume twice.
    await phases.tick();
    expect(listParts(db, phase.id).filter((part) => part.kind === "resume_after_fix")).toHaveLength(1);
  });
});
