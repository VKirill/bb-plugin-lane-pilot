import { describe, expect, it } from "vitest";
import { AUTO_TRIES, autoDue, contextDoc, createAutoStages, planItems } from "../src/rooms/phase/server/auto-stages";
import type { Phase, PhaseRecord } from "../src/rooms/phase/logic";

const phaseAt = (stage: string, record: PhaseRecord = {}, state = "active"): Phase => ({ id: "ph_1", projectId: "p", pmThreadId: "thr_pm", runId: "run1", title: "Notes",
  goal: "a notes module with a CLI", stage, state, record, edition: 1, createdAt: 1, updatedAt: 1 }) as unknown as Phase;

describe("what the machine runs at each stage", () => {
  it("the analysis at discussion, the plan at planning, the review of a finished wave, the goal audit after a passed verdict", () => {
    expect(autoDue(phaseAt("discussion"))).toEqual({ kind: "analyze" });
    expect(autoDue(phaseAt("planning", { context: { docs: [], sha: "c", signedAt: 1 } }))).toEqual({ kind: "plan" });
    expect(autoDue(phaseAt("execution", { waveReview: true, execution: { issued: {}, waves: { "1": { packageSha: "p", at: 1, lines: [{ id: "pieces_accepted", ok: true, detail: "" }] } } } } as never))).toEqual({ kind: "review", wave: 1 });
    expect(autoDue(phaseAt("verification", { verification: { verdict: { state: "passed", detail: "ok", inputSha: "x", at: 1, mainSha: null } } } as never))).toEqual({ kind: "close" });
    expect(autoDue(phaseAt("lessons", { lessons: { needed: true, why: "returns" } } as never))).toEqual({ kind: "lessons" });
    expect(autoDue(phaseAt("design", { design: { decision: "needed", why: "screens" } } as never))).toEqual({ kind: "draw" });
  });
  it("after a return to discussion signs the documents again instead of analysing anew", () => {
    expect(autoDue(phaseAt("discussion", { signedBefore: { docs: [".agents/phases/ph_1/CONTEXT.md"] } }))).toEqual({ kind: "resign" });
  });
  it("leaves the stage to the PM when paused, when train is off, or after two failed runs", () => {
    expect(autoDue(phaseAt("discussion", {}, "paused"))).toBeNull();
    expect(autoDue(phaseAt("discussion", { train: false }))).toBeNull();
    expect(autoDue(phaseAt("discussion", { autoFailures: { analyze: AUTO_TRIES } }))).toBeNull();
  });
});

describe("what the machine makes of a workflow's output", () => {
  it("writes the discussion's CONTEXT.md with decisions, risks by kind and open questions", () => {
    const doc = contextDoc(phaseAt("discussion"), { decisions: [{ id: "D1", text: "JSON file store", status: "locked" }, "atomic writes"],
      risks: [{ kind: "security", text: "no secrets in notes" }, "the temp file is left on a crash"], open_questions: ["Which tag syntax?"], scope_verdict: "medium" });
    expect(doc.decisions).toEqual(["D1", "D2"]);
    expect(doc.risks.security).toMatch(/no secrets/);
    expect(doc.risks.technical).toMatch(/temp file/);
    expect(doc.questions).toEqual(["Which tag syntax?"]);
    expect(doc.content).toMatch(/## Decisions[\s\S]*D1[\s\S]*## Risks[\s\S]*## Open questions/);
  });
  it("turns lp.plan's tasks and waves into pieces with a promise", () => {
    const items = planItems(phaseAt("planning"), { tasks: [{ id: "store", title: "Store", acceptance: ["writes are atomic"] }, { id: "cli", title: "CLI", acceptance: ["add works"] }], waves: [["store"], ["cli"]] });
    expect(items.map((item) => [item.id, item.wave])).toEqual([["store", 1], ["cli", 2]]);
    expect(items[0]!.promise.then).toBe("writes are atomic");
  });
});

describe("the machine's pass", () => {
  function world(output: Record<string, unknown> | null, status = "succeeded") {
    let phase = phaseAt("discussion");
    const calls: string[] = [];
    const runs = new Map<string, { status: string; output: Record<string, unknown> | null }>();
    const auto = createAutoStages({ log: () => undefined }, {
      workflowEngine: { start: (input: { workflow: { id: string } }) => { const runId = `wfrun_${runs.size + 1}`; calls.push(`start ${input.workflow.id}`); runs.set(runId, { status: "running", output: null }); return { runId, created: true, done: new Promise(() => undefined) }; },
        get: (runId: string) => ({ runId, reason: null, error: null, failedNode: null, waiting: [], stopped: false, ...runs.get(runId)! }) } as never,
    }, {
      api: {
        context: async (input) => { calls.push(`context ${input.docs.join(",")}`); phase = phaseAt("planning", { ...phase.record, context: { docs: [], sha: "c", signedAt: 1 } }); return phase; },
        plan: () => phase, planCheck: async () => phase, question: (input) => { calls.push(`question ${input.text}`); return phase; }, waveReview: () => phase, goalAudit: () => phase, lessons: () => phase, drawing: async () => phase,
      },
      get: () => phase,
      save: (_id, record) => { phase = { ...phase, record }; },
      book: (_phase, _section, kind) => { calls.push(`book ${kind}`); },
      writeDocs: async (_phase, files) => ({ written: files.map((file) => file.path) }),
      runtime: () => ({}),
      bookHead: () => "h".repeat(64),
      pmIdle: async () => true,
      now: () => 1,
    });
    return { auto, calls, runs, get: () => phase, finish: () => { runs.set("wfrun_1", { status, output }); } };
  }
  it("starts the analysis, then reports it through the gates; the PM is not poked meanwhile", async () => {
    const w = world({ decisions: [{ id: "D1", text: "store in JSON" }], risks: [], open_questions: ["Tags?"] });
    expect(await w.auto.step(w.get())).toBe(true);
    expect(w.calls).toContain("start lp.analyze");
    expect(await w.auto.step(w.get())).toBe(true);
    w.finish();
    expect(await w.auto.step(w.get())).toBe(true);
    expect(w.calls).toEqual(expect.arrayContaining(["question Tags?", "context .agents/phases/ph_1/CONTEXT.md", "book auto_done"]));
    expect(w.get().record.auto).toBeUndefined();
  });
  it("failures counted under an older version are forgotten: the new one tries the stage again", async () => {
    const w = world({ decisions: [] });
    const phase = w.get();
    (phase.record as Record<string, unknown>).autoFailures = { analyze: 2 };
    (phase.record as Record<string, unknown>).autoFailuresVersion = "0.0.1";
    expect(await w.auto.step(phase)).toBe(true);
    expect(w.calls).toContain("start lp.analyze");
    expect(w.calls).toContain("book auto_retry");
  });
  it("a run a reload stopped runs again without counting a try", async () => {
    const w = world(null, "failed");
    await w.auto.step(w.get());
    w.runs.set("wfrun_1", { status: "failed", output: null, error: "thread_failed: workflow_plan_critic:plugin_stopped" } as never);
    expect(await w.auto.step(w.get())).toBe(false);
    expect(w.get().record.autoFailures).toBeUndefined();
    expect(w.get().record.auto).toBeUndefined();
  });
  it("a run that fails counts; after two the stage is the PM's", async () => {
    const w = world(null, "failed");
    await w.auto.step(w.get());
    w.finish();
    expect(await w.auto.step(w.get())).toBe(false);
    expect(w.get().record.autoFailures).toEqual({ analyze: 1 });
  });
});

describe("signing again after a return", () => {
  it("signs the documents the return left, once the PM is idle", async () => {
    const { createAutoStages: create } = await import("../src/rooms/phase/server/auto-stages");
    let phase = phaseAt("discussion", { signedBefore: { docs: ["CONTEXT.md"], risks: { technical: "t" } } });
    const signed: string[][] = [];
    let idle = false;
    const auto = create({ log: () => undefined }, { workflowEngine: {} as never }, {
      api: { context: async (input) => { signed.push(input.docs); phase = phaseAt("planning", { ...phase.record, context: { docs: [], sha: "c", signedAt: 1 } }); return phase; },
        plan: () => phase, planCheck: async () => phase, question: () => phase, waveReview: () => phase, goalAudit: () => phase, lessons: () => phase, drawing: async () => phase },
      get: () => phase, save: (_id, record) => { phase = { ...phase, record }; }, book: () => undefined, writeDocs: async () => ({ written: [] }),
      runtime: () => ({}), bookHead: () => "h".repeat(64), pmIdle: async () => idle, now: () => 1,
    });
    expect(await auto.step(phase)).toBe(true);
    expect(signed).toEqual([]);
    idle = true;
    await auto.step(phase);
    expect(signed).toEqual([["CONTEXT.md"]]);
    expect(phase.record.signedBefore).toBeUndefined();
  });
});
