import { describe, expect, it } from "vitest";
import { MACHINE_STAGE_FAILURE, AUTO_LIFETIME_TRIES, AUTO_TRIES, autoDue, contextDoc, createAutoStages, planItems } from "../src/rooms/phase/server/auto-stages";
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
  it("is due for nothing when paused, when train is off, or after two failed runs (then the machine ends the loop itself, see `exhausted`)", () => {
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
  function world(output: Record<string, unknown> | null, status = "succeeded", start: Phase = phaseAt("discussion")) {
    let phase = start;
    let stopped = false;
    let planRefusal: Error | null = null;
    let exhaustFails = false;
    const booked: string[] = [];
    const calls: string[] = [];
    const runs = new Map<string, { status: string; output: Record<string, unknown> | null }>();
    const engine: Record<string, unknown> = {};
    const auto = createAutoStages({ log: () => undefined }, {
      workflowEngine: Object.assign(engine, { start: (input: { workflow: { id: string } }) => { const runId = `wfrun_${runs.size + 1}`; calls.push(`start ${input.workflow.id}`); runs.set(runId, { status: "running", output: null }); return { runId, created: true, done: new Promise(() => undefined) }; },
        get: (runId: string) => ({ runId, reason: null, error: null, failedNode: null, waiting: [], stopped: false, ...runs.get(runId)! }) }) as never,
    }, {
      exhausted: async (_phase, input) => { calls.push(`exhausted ${input.kind} ${input.stage}`); if (exhaustFails) throw new Error("the attempt could not be canceled"); },
      api: {
        context: async (input) => { calls.push(`context ${input.docs.join(",")}`); phase = phaseAt("planning", { ...phase.record, context: { docs: [], sha: "c", signedAt: 1 } }); return phase; },
        plan: (input) => { calls.push(`plan ${input.items.length}${input.alreadyMet ? ` already_met: ${input.alreadyMet}` : ""}`); return phase; }, planCheck: async (input) => { calls.push(`planCheck ${input.decision}`); if (planRefusal) throw planRefusal; return phase; }, question: (input) => { calls.push(`question ${input.text}`); return phase; }, waveReview: () => phase, goalAudit: (input) => { calls.push(`goalAudit ${input.state}\n${input.summary}`); return phase; }, lessons: () => phase, drawing: async () => phase,
        returnTo: (input) => { calls.push(`return ${input.to}`); phase = { ...phase, stage: input.to } as Phase; return phase; },
      },
      get: () => phase,
      save: (_id, record) => { phase = { ...phase, record }; },
      book: (_phase, _section, kind, text) => { calls.push(`book ${kind}`); booked.push(String(text)); },
      writeDocs: async (_phase, files) => ({ written: files.map((file) => file.path) }),
      runtime: () => ({}),
      bookHead: () => "h".repeat(64),
      pmIdle: async () => true,
      now: () => 1,
      runStopped: async () => stopped,
    });
    return { auto, calls, runs, engine, booked, failExhaust: () => { exhaustFails = true; }, failPlan: (error: Error) => { planRefusal = error; }, stop: (value = true) => { stopped = value; }, get: () => phase, finish: () => { runs.set("wfrun_1", { status, output }); } };
  }
  it("starts no stage workflow while the run is halted or paused, and starts it once the run goes on", async () => {
    const w = world({ decisions: [], risks: [], open_questions: [] });
    w.stop();
    // True: the machine holds the stage, so the PM is not poked with a step meanwhile.
    expect(await w.auto.step(w.get())).toBe(true);
    expect(w.calls).not.toContain("start lp.analyze");
    w.stop(false);
    expect(await w.auto.step(w.get())).toBe(true);
    expect(w.calls).toContain("start lp.analyze");
  });
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
  it("an unmet goal audit reports each unmet goal with what it lacks and the drift, so the replan knows what to plan", async () => {
    const verified = phaseAt("verification", { verification: { verdict: { state: "passed", detail: "ok", inputSha: "x", at: 1, mainSha: null } } } as never);
    const w = world({ status: "unmet", unmet_ids: [], intent_aligned: false, drift_items: ["server gift policy merged outside the UI phase"],
      goals: [{ id: "R1", status: "MET" }, { id: "R2", status: "UNMET", missing: "Studio screenshots of the current HUD at all four sizes" }] }, "succeeded", verified);
    expect(await w.auto.step(w.get())).toBe(true);
    expect(w.calls).toContain("start lp.close");
    w.finish();
    expect(await w.auto.step(w.get())).toBe(true);
    const audit = w.calls.find((call) => call.startsWith("goalAudit"))!;
    expect(audit).toContain("goalAudit unmet");
    expect(audit).toContain("- R2: Studio screenshots of the current HUD at all four sizes");
    expect(audit).toContain("- drift: server gift policy merged outside the UI phase");
    expect(audit).not.toContain("- R1");
  });
  it("a close halted by the old owner form still hands the replan its goals, read from the audit step", async () => {
    const verified = phaseAt("verification", { verification: { verdict: { state: "passed", detail: "ok", inputSha: "x", at: 1, mainSha: null } } } as never);
    const w = world({ status: "halted", intent_aligned: false }, "succeeded", verified);
    expect(await w.auto.step(w.get())).toBe(true);
    w.finish();
    w.engine.snapshot = () => ({ run: {}, events: [], steps: [{ node_id: "goal_audit", output_json: JSON.stringify({ goals: [{ id: "R3", status: "UNMET", missing: "current Pig screenshots" }], drift_items: [] }) }] });
    expect(await w.auto.step(w.get())).toBe(true);
    expect(w.calls.find((call) => call.startsWith("goalAudit"))).toContain("- R3: current Pig screenshots");
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
  // Review 2026-10-26 §1: lp.plan answers «already met» with no tasks; apply() threw on the empty list and the phase demanded work again.
  it("an empty plan with already_met is booked and reported through the gates, not failed", async () => {
    const planning = phaseAt("planning", { context: { docs: [], sha: "c", signedAt: 1 } });
    const w = world({ status: "ok", tasks: [], waves: [], task_count: 0, already_met: true, objective: "notes module with a CLI exists", has_ui: false }, "succeeded", planning);
    await w.auto.step(w.get());
    expect(w.calls).toContain("start lp.plan");
    w.finish();
    expect(await w.auto.step(w.get())).toBe(true);
    expect(w.calls).toContain("plan 0 already_met: the planner checked the repository: notes module with a CLI exists");
    expect(w.calls).toContain("planCheck approve");
    expect(w.calls).toContain("book auto_done");
    expect(w.calls).not.toContain("book auto_failed");
    expect(w.get().record.autoFailures).toBeUndefined();
  });
  it("an empty plan without already_met, or after a failed verdict, is still a failure", async () => {
    const planning = (record: PhaseRecord) => phaseAt("planning", { context: { docs: [], sha: "c", signedAt: 1 }, ...record });
    for (const [output, record] of [[{ status: "ok", tasks: [] }, {}], [{ status: "ok", tasks: [], already_met: true }, { replan: { gaps: "goal audit: unmet", count: 1 } }]] as const) {
      const w = world(output, "succeeded", planning(record));
      await w.auto.step(w.get());
      w.finish();
      await w.auto.step(w.get());
      expect(w.calls).toContain("book auto_failed");
      expect(w.calls.some((call) => call.startsWith("plan "))).toBe(false);
    }
  });
  it("a new version forgets the stage's tries but not its lifetime total: six failed runs and the stage stays the PM's", async () => {
    const w = world(null, "failed");
    const phase = w.get();
    (phase.record as Record<string, unknown>).autoFailures = { analyze: 2 };
    (phase.record as Record<string, unknown>).autoFailuresTotal = { analyze: AUTO_LIFETIME_TRIES - 2 };
    (phase.record as Record<string, unknown>).autoFailuresVersion = "0.0.1";
    // Under 6 in all: the new version tries again.
    expect(await w.auto.step(phase)).toBe(true);
    expect(w.calls).toContain("start lp.analyze");
    // The cap reached: the same reset leaves the stage to the PM.
    const capped = world({ decisions: [] });
    const old = capped.get();
    (old.record as Record<string, unknown>).autoFailures = { analyze: 2 };
    (old.record as Record<string, unknown>).autoFailuresTotal = { analyze: AUTO_LIFETIME_TRIES };
    (old.record as Record<string, unknown>).autoFailuresVersion = "0.0.1";
    expect(await capped.auto.step(old)).toBe(false);
    expect(capped.calls).not.toContain("start lp.analyze");
    expect(autoDue(phaseAt("discussion", { autoFailuresTotal: { analyze: AUTO_LIFETIME_TRIES } }))).toBeNull();
    expect(autoDue(phaseAt("discussion", { autoFailuresTotal: { analyze: AUTO_LIFETIME_TRIES - 1 } }))).toEqual({ kind: "analyze" });
  });
  it("every failed run adds to the lifetime total, which the version reset leaves alone", async () => {
    const w = world(null, "failed");
    await w.auto.step(w.get());
    w.finish();
    await w.auto.step(w.get());
    expect(w.get().record.autoFailuresTotal).toEqual({ analyze: 1 });
    const record = w.get().record as Record<string, unknown>;
    record.autoFailuresVersion = "0.0.1";
    await w.auto.step(w.get());
    expect(w.get().record.autoFailures).toBeUndefined();
    expect(w.get().record.autoFailuresTotal).toEqual({ analyze: 1 });
  });
  it("a run a reload stopped runs again without counting a try", async () => {
    const w = world(null, "failed");
    await w.auto.step(w.get());
    w.runs.set("wfrun_1", { status: "failed", output: null, error: "thread_failed: workflow_plan_critic:plugin_stopped" } as never);
    expect(await w.auto.step(w.get())).toBe(false);
    expect(w.get().record.autoFailures).toBeUndefined();
    expect(w.get().record.auto).toBeUndefined();
  });
  it("an analysis that names a security risk writes and signs SECURITY.md with the context, so the plan's threat gate can pass (drill ph_5cd09d1c7a)", async () => {
    const { threatGap } = await import("../src/rooms/phase/stages");
    const doc = contextDoc(phaseAt("discussion"), { risks: [{ kind: "security", text: "drills/ is a new tracked top-level directory any writer may write" }] });
    expect(doc.security).toMatch(/Threat model[\s\S]*drills\/ is a new tracked/);
    expect(contextDoc(phaseAt("discussion"), { risks: [{ kind: "technical", text: "x" }] }).security).toBeNull();
    const w = world({ risks: [{ kind: "security", text: "a token could leak" }] });
    await w.auto.step(w.get()); w.finish(); await w.auto.step(w.get());
    const signed = w.calls.find((call) => call.startsWith("context "));
    expect(signed).toMatch(/CONTEXT\.md,.*SECURITY\.md/);
    expect(threatGap({ context: { docs: [{ path: ".agents/phases/ph_1/CONTEXT.md" }, { path: ".agents/phases/ph_1/SECURITY.md" }], risks: { security: "a token could leak" } } } as never)).toBeNull();
  });
  it("books a gate's reasons with its refusal, not only «the plan is not admitted»", async () => {
    const w = world({ tasks: [{ id: "t1" }] }, "succeeded", phaseAt("planning", { context: { docs: [], sha: "c", signedAt: 1 } } as never));
    const refusal = Object.assign(new Error("the plan is not admitted"), { why: ["the security risk «x» needs a threat model"] });
    w.failPlan(refusal);
    await w.auto.step(w.get()); w.finish(); await w.auto.step(w.get());
    expect(w.booked.find((text) => text.includes("not admitted"))).toMatch(/not admitted: the security risk «x» needs a threat model/);
  });
  it("a stage that fails for Lane Pilot's own reasons waits for a fixed release: it never cuts the phase's scope (Fable's recheck, 2026-10-27)", async () => {
    // Every stage failure the live phases ever booked, before 0.1.336. Only the planner's and the drawing's verdicts are about the work.
    const machine = ["thread_failed: workflow_goal_audit:error:thread_status_error:provider_error:Provider error", "guard:maxVisits:plan_critic: \"plan\" has used its visits", "thread_failed: workflow_plan_critic:plugin_stopped", "budget_exceeded:steps", "output field \"scores_min\" is missing", "repo_edited: the analyst helper edited repository files it may not touch: .agents/phases/ph_26f65b142d/CONTEXT.md", "repo_edited: the planner helper edited repository files it may not touch: .agents/plans/ui3/plan-items.json", "repo_edited: the plan-critic helper edited repository files it may not touch: .agents/phases/ph_26f65b142d/design/src/fonts/fredoka-500.ttf,", "cannot read .agents/phases/ph_26f65b142d/design/00-kit.png: lane_pilot_read_binary_rejected"];
    for (const why of machine) expect(MACHINE_STAGE_FAILURE.test(why), why).toBe(true);
    for (const why of ["the drawing is not confirmed", "the plan is not admitted"]) expect(MACHINE_STAGE_FAILURE.test(why), why).toBe(false);
    const w = world(null, "failed");
    for (const run of ["wfrun_1", "wfrun_2", "wfrun_3"]) {
      await w.auto.step(w.get());
      w.runs.set(run, { status: "failed", output: null, error: "repo_edited: the analyst helper edited repository files it may not touch: src/app.ts" } as never);
      await w.auto.step(w.get());
    }
    expect(w.calls.filter((call) => call.startsWith("exhausted"))).toEqual([]);
    expect(w.get().record.autoFailuresTotal).toBeUndefined();
    expect(w.get().record.autoFailures).toEqual({ analyze: AUTO_TRIES });
  });
  it("spent replans end the loop once: if the machine's outcome throws before it saves, the next passes do not book and call it again (Fable's recheck E5)", async () => {
    const w = world(null, "succeeded", phaseAt("verification", { verification: { verdict: { state: "failed", detail: "b not accepted", inputSha: "x", at: 1, mainSha: null } }, replan: { count: 2 } } as never));
    w.failExhaust();
    expect(await w.auto.step(w.get())).toBe(true);
    expect(await w.auto.step(w.get())).toBe(true);
    expect(await w.auto.step(w.get())).toBe(true);
    expect(w.calls.filter((call) => call === "exhausted replan replan")).toHaveLength(1);
    expect(w.calls.filter((call) => call === "book replans_spent")).toHaveLength(1);
    expect(w.get().record.exhausted).toEqual({ at: 1 });
    // The failure of the outcome is booked once, so the owner and the PM can see why the phase stands.
    expect(w.calls.filter((call) => call === "book exhaust_failed")).toHaveLength(1);
  });
  it("a run that fails counts and is run again on the next pass; the second failure ends the loop (the machine's outcome, not the PM's)", async () => {
    const w = world(null, "failed");
    await w.auto.step(w.get());
    w.finish();
    expect(await w.auto.step(w.get())).toBe(false);
    expect(w.get().record.autoFailures).toEqual({ analyze: 1 });
    expect(w.calls.filter((call) => call.startsWith("exhausted"))).toEqual([]);
    expect(await w.auto.step(w.get())).toBe(true);
    w.runs.set("wfrun_2", { status: "failed", output: null });
    expect(await w.auto.step(w.get())).toBe(true);
    expect(w.get().record.autoFailures).toEqual({ analyze: AUTO_TRIES });
    expect(w.calls.filter((call) => call.startsWith("exhausted"))).toEqual(["exhausted stage analyze"]);
    expect(JSON.stringify(w.calls)).not.toMatch(/PM's|waits for a person/);
  });
});

describe("a failed verdict is planned again by the machine", () => {
  const failed = { context: { docs: [], sha: "c", signedAt: 1 }, verification: { verdict: { state: "failed", detail: "goal audit: unmet: [\"ph-ui-panels\"]", inputSha: "x", at: 1, mainSha: null } },
    plan: { items: [{ id: "ph-ui-panels", title: "Panels", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id: "ph-ui-panels" } }], sha: "s", contextSha: "c" } };
  it("returns the phase to planning with the verdict, plans the gaps keeping the other pieces, twice at most", async () => {
    expect(autoDue(phaseAt("verification", failed as never))).toEqual({ kind: "replan" });
    expect(autoDue(phaseAt("verification", { ...failed, replan: { count: 2 } } as never))).toBeNull();
    const back = phaseAt("planning", { ...failed, replan: { gaps: "goal audit: unmet: [\"ph-ui-panels\"]", count: 1 } } as never);
    expect(autoDue(back)).toEqual({ kind: "plan" });
    const { autoInputs } = await import("../src/rooms/phase/server/auto-stages");
    const inputs = autoInputs(back, { kind: "plan" }) as { mode: string; gaps: string[]; findings: { current_pieces: Array<{ id: string }> }; extra_rules: string[] };
    expect(inputs.mode).toBe("gaps");
    expect(inputs.gaps[0]).toMatch(/verification failed: goal audit: unmet/);
    expect(inputs.findings.current_pieces.map((piece) => piece.id)).toEqual(["ph-ui-panels"]);
    expect(inputs.extra_rules.join(" ")).toMatch(/exactly as it is/);
    expect(inputs.extra_rules.join(" ")).toMatch(/never change an accepted piece's contract to re-prove it/);
  });
});

describe("a plan the gate refused", () => {
  it("is planned again with the current pieces and their covers, to be returned whole with what the gate names fixed", async () => {
    const { autoInputs } = await import("../src/rooms/phase/server/auto-stages");
    const piece = { id: "a", title: "a", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id: "a" }, covers: ["D1"] };
    const phase = phaseAt("planning", { context: { docs: [], sha: "c", signedAt: 1, decisions: ["D1", "D2"] }, plan: { items: [piece], sha: "s", contextSha: "c", critique: { decision: "approve", by: "critic", summary: "ok", at: 1 } } } as never);
    expect(autoDue(phase)).toEqual({ kind: "plan" });
    const inputs = autoInputs(phase, { kind: "plan" }) as { gaps: string[]; findings: { current_pieces: Array<{ id: string; covers: string[] }> }; extra_rules: string[] };
    expect(inputs.gaps.join(" ")).toMatch(/D2/);
    expect(inputs.findings.current_pieces).toEqual([expect.objectContaining({ id: "a", covers: ["D1"] })]);
    expect(inputs.extra_rules.join(" ")).toMatch(/return the whole plan again/);
  });
});

describe("a replan merges into the pieces that were", () => {
  it("keeps the pieces the planner did not return, replaces the returned ones, puts them after the old waves, and carries covers", async () => {
    const piece = (id: string, wave: number, covers?: string[]) => ({ id, title: id, wave, promise: { given: "g", when: "w", then: "t" }, task: { id }, ...(covers ? { covers } : {}) });
    let phase = phaseAt("planning", { context: { docs: [], sha: "c", signedAt: 1 }, replan: { gaps: "unmet: [b]", count: 1 },
      plan: { items: [piece("a", 1, ["D1"]), piece("b", 1, ["D2"])], sha: "s", contextSha: "c" } } as never);
    let planned: Array<{ id: string; wave: number; covers?: string[]; task: Record<string, unknown> }> = [];
    const runs = new Map<string, { status: string; output: Record<string, unknown> | null }>();
    const auto = createAutoStages({ log: () => undefined }, {
      workflowEngine: { start: () => { runs.set("wfrun_1", { status: "running", output: null }); return { runId: "wfrun_1", created: true, done: new Promise(() => undefined) }; },
        get: (runId: string) => ({ runId, reason: null, error: null, failedNode: null, waiting: [], stopped: false, ...runs.get(runId)! }) } as never,
    }, {
      exhausted: async () => undefined,
      api: { context: async () => phase, plan: (input) => { planned = input.items as never; return phase; }, planCheck: async () => phase, question: () => phase, waveReview: () => phase,
        goalAudit: () => phase, lessons: () => phase, drawing: async () => phase, returnTo: () => phase },
      get: () => phase, save: (_id, record) => { phase = { ...phase, record }; }, book: () => undefined, writeDocs: async () => ({ written: [] }),
      runtime: () => ({}), bookHead: () => "h".repeat(64), pmIdle: async () => true, now: () => 1,
    });
    await auto.step(phase);
    runs.set("wfrun_1", { status: "succeeded", output: { status: "ok", tasks: [{ id: "b", title: "b again", covers: ["D2"] }, { id: "c", title: "c", covers: ["D3"] }], waves: [["b"], ["c"]] } });
    await auto.step(phase);
    expect(planned.map((item) => [item.id, item.wave, item.covers])).toEqual([["a", 1, ["D1"]], ["b", 2, ["D2"]], ["c", 3, ["D3"]]]);
    expect(planned[1]!.task.covers).toBeUndefined();
  });
});

describe("the machine's return after a failed verdict", () => {
  it("returns the phase to planning through the gates and notes what to plan", async () => {
    let phase = phaseAt("verification", { context: { docs: [], sha: "c", signedAt: 1 }, verification: { verdict: { state: "failed", detail: "goal audit: unmet: [p1]", inputSha: "x", at: 1, mainSha: null } } } as never);
    const returns: string[] = [];
    const auto = createAutoStages({ log: () => undefined }, { workflowEngine: {} as never }, {
      exhausted: async () => undefined,
      api: { context: async () => phase, plan: () => phase, planCheck: async () => phase, question: () => phase, waveReview: () => phase, goalAudit: () => phase, lessons: () => phase, drawing: async () => phase,
        returnTo: (input) => { returns.push(`${input.to}: ${input.note}`); phase = { ...phase, stage: input.to } as Phase; return phase; } },
      get: () => phase, save: (_id, record) => { phase = { ...phase, record }; }, book: () => undefined, writeDocs: async () => ({ written: [] }),
      runtime: () => ({}), bookHead: () => "h".repeat(64), pmIdle: async () => true, now: () => 1,
    });
    expect(await auto.step(phase)).toBe(true);
    expect(returns).toEqual(["planning: the verification failed (1 of 2 machine returns): goal audit: unmet: [p1]"]);
    expect(phase.record.replan).toEqual({ gaps: "goal audit: unmet: [p1]", count: 1 });
  });
});

describe("signing again after a return", () => {
  it("signs the documents the return left, once the PM is idle", async () => {
    const { createAutoStages: create } = await import("../src/rooms/phase/server/auto-stages");
    let phase = phaseAt("discussion", { signedBefore: { docs: ["CONTEXT.md"], risks: { technical: "t" } } });
    const signed: string[][] = [];
    let idle = false;
    const auto = create({ log: () => undefined }, { workflowEngine: {} as never }, {
      exhausted: async () => undefined,
      api: { context: async (input) => { signed.push(input.docs); phase = phaseAt("planning", { ...phase.record, context: { docs: [], sha: "c", signedAt: 1 } }); return phase; },
        plan: () => phase, planCheck: async () => phase, question: () => phase, waveReview: () => phase, goalAudit: () => phase, lessons: () => phase, drawing: async () => phase, returnTo: () => phase },
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
