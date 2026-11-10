import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import {
  acceptanceLines, designDecision, designGate, observationDue, observationOutcome, planSignature, resolvePhaseRef,
  type Phase, type PhaseRecord, type PlanItem,
} from "../../src/rooms/phase";
import { uiContractGap, uatText } from "../../src/rooms/phase/stages";
import { autoDue, autoInputs, createAutoStages } from "../../src/rooms/phase/server/auto-stages";
import { appendPart, getPhase, insertPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/plugin-db";

const phase = (record: PhaseRecord, stage: Phase["stage"] = "design", over: Partial<Phase> = {}): Phase => ({
  id: "ph_sma", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0, ...over,
});
const item = (id: string, over: Partial<PlanItem> = {}): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: `then-${id}` },
  task: { id, project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: [`acc-${id}`] }, ...over,
});

function driver(status = "idle") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: Array<{ threadId: string; mode: string; text: string }> = [];
  harness.sdk.stub("threads.send", async (input: { threadId: string; mode: string; input: Array<{ text: string }> }) => { sent.push({ threadId: input.threadId, mode: input.mode, text: input.input[0]!.text }); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  const phases = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined }, rollback: {} } as unknown as Services).phases;
  return { phases, sent, db, bb };
}

describe("phase design", () => {
  it("[sma:ts_needs_clarify] the machine does not draw over an open design question", () => {
    const record: PhaseRecord = {
      context: { docs: [], sha: "ctx", signedAt: 1 }, plan: { items: [item("p1")], contextSha: "ctx", sha: "s", admittedSha: "s" },
      design: { decision: "needed", why: "screens" },
      questions: [{ id: "q1", stage: "design", text: "Which grid?", blocking: true, askedAt: 1 }],
    };
    expect(autoDue(phase(record))).toBeNull();
    const gate = designGate(record);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.why.join(" ")).toContain("q1");
    const answered = { ...record, questions: [{ ...record.questions![0]!, answer: "the 8px one" }] };
    expect(autoDue(phase(answered))).toEqual({ kind: "draw" });
  });

  it("[sma:p3_requirements] keeps the drawing's requirements and refuses a UI-SPEC that misses one", () => {
    const mixed = designDecision([
      item("scr", { task: { id: "scr", owns_paths: ["src/ui/page.tsx"], verification: [{ command: "npm test" }] } }),
      item("sys", { task: { id: "sys", owns_paths: ["DESIGN.md"], verification: [{ command: "npm test" }] } }),
    ]);
    expect(mixed.mode).toBe("mixed");
    expect(mixed.requirements).toEqual(expect.arrayContaining(["actions", "screens_states", "texts", "heuristics", "accessibility", "c4", "event_chain"]));
    const record: PhaseRecord = { design: { decision: "needed", why: "screens", requirements: mixed.requirements, drawing: { paths: ["d/one.html", "d/UI-SPEC.md"], sha256: "x", designer: "a", feasible: true, reviewer: "b" } } };
    const lacking = ["## Actions", "## Screens and states", "## Texts", "## Heuristics", "## C4", "## Event chain"].join("\n");
    const gap = uiContractGap(record, lacking);
    expect(gap).toContain("accessibility");
    const full = ["## Actions", "## Screens and states", "## Texts", "## Heuristics", "## Accessibility", "## C4 diagrams", "## Event chain"].join("\n");
    expect(uiContractGap(record, full)).toBeNull();
    const gate = designGate(record, lacking);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.why.join(" ")).toContain("accessibility");
    expect(designGate(record, full).ok).toBe(true);
  });

  it("[sma:p3_judge] journals the drawing checker's scores and remarks apart from the drawing", async () => {
    const journaled: unknown[] = [];
    const drawn: unknown[] = [];
    const auto = createAutoStages({ log: () => undefined } as never, { workflowEngine: {} as never }, {
      api: { drawing: async (input: unknown) => { drawn.push(input); return phase({}); } } as never,
      exhausted: async () => undefined, get: () => phase({}), save: () => undefined, book: () => undefined,
      writeDocs: async () => ({ written: [] }), runtime: () => null, pmIdle: async () => true, now: () => 7,
      journal: async (line: unknown) => { journaled.push(line); },
    });
    const output = { verdict: "pass", scores: { hierarchy: 3, spacing: 2, contrast: 3, states: 2 }, notes: "ok", paths: ["d/UI-SPEC.md"] };
    await auto.apply(phase({ design: { decision: "needed", why: "x" } }), { kind: "draw", wfRunId: "wf1", startedAt: 1 }, output as never);
    expect((drawn[0] as { critique: { scores: unknown; verdict: string; notes: string } }).critique).toEqual({ scores: output.scores, verdict: "pass", notes: "ok" });
    await expect(auto.apply(phase({ design: { decision: "needed", why: "x" } }), { kind: "draw", wfRunId: "wf1", startedAt: 1 }, { verdict: "rework", scores: output.scores, notes: "redo the states", paths: [] } as never)).rejects.toThrow(/rework/);
    expect(journaled).toHaveLength(1);
    expect((journaled[0] as { critique: { verdict: string; notes: string } }).critique).toMatchObject({ verdict: "rework", notes: "redo the states" });
  });
});

describe("phase verification and acceptance", () => {
  const closePhase = () => phase({
    execution: { issued: { p1: "t1", p2: "t2" }, baseSha: "base0" },
    verification: { verdict: { state: "passed", detail: "the blind detail", mainSha: "m1", at: 1, inputSha: "i1" } },
    design: { decision: "needed", why: "x", drawing: { paths: ["d/UI-SPEC.md", "d/one.html"], sha256: "drawsha", designer: "a" } },
    plan: { items: [item("p1"), item("p2", { task: { id: "p2", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["acc-p2"], depends_on: ["p1"] } })], contextSha: "c", sha: "s", admittedSha: "s" },
    candidate: { branch: "phase/ph_sma", trees: { base: { path: "/r/.git/lp-phases/ph_sma", startSha: "s0" } } },
  }, "verification");

  it("[sma:p5_inputs] hands the goal audit every promise, the diff range and the drawing", () => {
    const inputs = autoInputs(closePhase(), { kind: "close" });
    const goals = inputs.goals as Array<{ id: string; done_when: string }>;
    expect(goals).toHaveLength(2);
    expect(goals[0]!.done_when).toContain("given g; when w; then then-p1");
    expect(goals[0]!.done_when).toContain("acc-p1");
    expect(inputs.merged_commits).toEqual(["base0..phase/ph_sma"]);
    expect((inputs.drawing as { paths: string[]; sha256: string }).paths).toContain("d/UI-SPEC.md");
    expect((inputs.drawing as { sha256: string }).sha256).toBe("drawsha");
  });

  it("[sma:p5_prompt] gives the goal audit each piece's contract and dependencies", () => {
    const inputs = autoInputs(closePhase(), { kind: "close" });
    const goals = inputs.goals as Array<{ id: string; depends_on: string[]; contract: { verification: unknown[]; acceptance: unknown[] } }>;
    const p2 = goals.find((goal) => goal.id === "p2")!;
    expect(p2.depends_on).toEqual(["p1"]);
    expect(p2.contract.verification).toEqual([{ command: "npm test" }]);
    expect(p2.contract.acceptance).toEqual(["acc-p2"]);
    expect(String(inputs.summary)).toContain("phase/ph_sma");
    expect(String(inputs.summary)).toContain("the blind detail");
  });

  it("[sma:p5_uat_stage] points the UAT at the phase candidate tree", () => {
    const text = uatText(closePhase());
    expect(text).toContain("phase/ph_sma");
    expect(text).toContain("/r/.git/lp-phases/ph_sma");
    expect(text).not.toMatch(/^Test the work on main\./m);
    const verified = uatText(phase({ ...closePhase().record, candidate: { ...closePhase().record.candidate!, verified: { base: "abc123def" } } }));
    expect(verified).toContain("abc123def".slice(0, 12));
    const plain = uatText(phase({ plan: { items: [item("p1")], contextSha: "c", sha: "s" } }));
    expect(plain).toContain("Test the work on main.");
  });

  it("[sma:bc_closure] closing re-computes coverage: a dropped requirement holds the phase at acceptance", () => {
    const record: PhaseRecord = {
      context: { docs: [], sha: "c", signedAt: 1, requirements: ["R1"] },
      plan: { items: [item("p1", { covers: ["R1"] })], contextSha: "c", sha: "s", admittedSha: "s" },
      verification: { verdict: { state: "passed", detail: "ok", mainSha: "m", at: 1, inputSha: "i" }, model: { state: "met", by: "audit", summary: "met", at: 1 } },
      scope: { revisions: 0, withdrawn: [] },
    };
    const facts = new Map([["p1", { taskId: "t1", state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed" } as never]]);
    const lines = acceptanceLines(phase(record, "acceptance"), facts, { mainSha: "m", openDeferrals: 0 });
    expect(lines.find((line) => line.id === "nothing_missing")?.ok).toBe(true);
    expect(lines.find((line) => line.id === "book_intact")?.ok).toBe(true);
    // The piece covering R1 was withdrawn: the plan is re-admitted trimmed, and the requirement is left uncovered.
    const withdrawn: PhaseRecord = { ...record, plan: { ...record.plan!, items: [] }, scope: { revisions: 0, withdrawn: ["p1"] } };
    const held = acceptanceLines(phase(withdrawn, "acceptance"), new Map(), { mainSha: "m", openDeferrals: 0 });
    const line = held.find((row) => row.id === "nothing_missing");
    expect(line?.ok).toBe(false);
    expect(line?.detail).toContain("R1");
    const broken = acceptanceLines(phase(record, "acceptance"), facts, { mainSha: "m", openDeferrals: 0, bookBroken: 4 });
    expect(broken.find((row) => row.id === "book_intact")).toMatchObject({ ok: false });
  });

  it("[sma:ta_view] the acceptance package carries the key, the verdict and the diff of the shown package", async () => {
    const { phases, db } = driver();
    const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Pkg", goal: "pkg" });
    savePhase(db, ph.id, { stage: "acceptance", record: { ...ph.record, ownerWords: true,
      plan: { items: [item("p1")], contextSha: "c", sha: "s", admittedSha: "s" },
      execution: { issued: { p1: "t1" }, baseSha: "base0" },
      verification: { verdict: { state: "passed", detail: "all proved", mainSha: "head9", at: 1, inputSha: "in1" } } } as never, at: 2 });
    const pkg = await phases.acceptancePackage(ph.id);
    expect(pkg?.verdict).toMatchObject({ state: "passed", detail: "all proved", mainSha: "head9" });
    expect(pkg?.key).toMatch(/^[0-9a-f]{16}$/);
    const status = phases.status(ph.id) as { ownerWord: { acceptanceKey: string } };
    expect(pkg?.key).toBe(status.ownerWord.acceptanceKey);
  });
});

describe("phase control and daemon", () => {
  it("[sma:pc_folder] resolves a phase number or folder to one phase and refuses ambiguity", async () => {
    const { phases, db } = driver();
    insertPhase(db, { id: "ph_a", projectId: "projA", pmThreadId: "t", title: "A", goal: "a", at: 1 });
    insertPhase(db, { id: "ph_b", projectId: "projA", pmThreadId: "t", title: "B", goal: "b", at: 1 });
    savePhase(db, "ph_a", { record: { roadmapRow: "3" }, at: 2 });
    expect(resolvePhaseRef(db, "projA", ".agents/phases/ph_a").id).toBe("ph_a");
    expect(resolvePhaseRef(db, "projA", "3").id).toBe("ph_a");
    expect(() => resolvePhaseRef(db, "projA", "9")).toThrow(/no live phase on roadmap row 9/);
    savePhase(db, "ph_b", { record: { roadmapRow: "3" }, at: 3 });
    expect(() => resolvePhaseRef(db, "projA", "3")).toThrow(/ph_a.*ph_b|ph_b.*ph_a/);
    await expect(phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "C", goal: "c", roadmapRow: "3" })).rejects.toThrow(/ph_a|ph_b/);
  });

  it("[sma:dt_park_waves] stop_wave cancels the queued piece and corrects the running writer after its turn", async () => {
    const { phases, sent, db } = driver();
    createTask(db, { id: "piece1", runId: "run1", kind: "bb", contract: {} });
    createTask(db, { id: "piece2", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "att_q", runId: "run1", taskId: "piece1" });
    transitionAttempt(db, "att_q", "queued");
    createAttempt(db, { id: "att_r", runId: "run1", taskId: "piece2" });
    transitionAttempt(db, "att_r", "spawn_requested");
    transitionAttempt(db, "att_r", "running", { threadId: "thr_w" });
    const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Wave", goal: "wave" });
    savePhase(db, ph.id, { stage: "execution", runId: "run1", record: { ...ph.record, plan: { items: [item("piece1"), item("piece2")], contextSha: "c", sha: "s", admittedSha: "s" },
      execution: { issued: { piece1: "piece1", piece2: "piece2" } } } as never, at: 2 });
    const out = await phases.stopWave({ phaseId: ph.id });
    expect(out.canceled).toEqual(["piece1"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId: "thr_w", mode: "queue-if-active" });
    expect(sent[0]!.text).toContain("wave is stopped");
    expect(listParts(db, ph.id).some((part) => part.kind === "wave_live_corrected" && part.text.includes("piece2"))).toBe(true);
  });

  it("[sma:dt_aging] the age keeps counting past its own note and nothing is stored for it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { phases, db } = driver();
      const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats" });
      await phases.tick();
      vi.setSystemTime(Date.now() + 4 * 86_400_000);
      await phases.tick();
      vi.setSystemTime(Date.now() + 1 * 86_400_000 + 3_600_000);
      await phases.tick();
      expect(listParts(db, ph.id).filter((part) => part.kind === "aging").map((part) => part.text)).toEqual([
        "no movement for 4 day(s) at discussion", "no movement for 5 day(s) at discussion"]);
      await phases.tick();
      expect(listParts(db, ph.id).filter((part) => part.kind === "aging")).toHaveLength(2);
      expect("agingSaidAt" in getPhase(db, ph.id)!.record).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("[sma:p6_observe] watches an accepted phase for rollbacks for seven days without touching its acceptance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { phases, db } = driver();
      createTask(db, { id: "piece1", runId: "run1", kind: "bb", contract: {} });
      const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Obs", goal: "obs" });
      const record: PhaseRecord = { ...ph.record, plan: { items: [item("piece1")], contextSha: "c", sha: "s", admittedSha: "s" },
        execution: { issued: { piece1: "piece1" } }, acceptance: { lines: [], at: 1, accepted: true }, closedDocs: { at: 1, commit: null } };
      savePhase(db, ph.id, { stage: "closed", state: "closed", record, at: Date.now() });
      // No merge commits of the phase's work exist: nothing to read.
      await phases.tick();
      expect(getPhase(db, ph.id)!.record.observation?.outcome).toBe("no_data");
      // A merged revert receipt on the piece: the observation says failure and names it; acceptance and state stand.
      db.prepare("INSERT INTO lane_pilot_task_receipt(at,kind,project_id,run_id,task_id,attempt_id,base_sha,change_sha,result_commit,state,summary,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(2, "revert", "projA", "run1", "piece1", "att", "b0", "deadbeef", "cafe01", "merged", "reverted", "{}");
      const closedAt = getPhase(db, ph.id)!.closedAt;
      savePhase(db, ph.id, { record: { ...getPhase(db, ph.id)!.record, observation: undefined } as never, at: Date.now() + 5 });
      // A bookkeeping write to a closed phase does not move the moment it closed (it would push the watch forward forever).
      expect(getPhase(db, ph.id)!.closedAt).toBe(closedAt);
      // The watch is a host git call: the same phase is read again only six hours later.
      await phases.tick();
      expect(getPhase(db, ph.id)!.record.observation).toBeUndefined();
      vi.setSystemTime(Date.now() + 7 * 3_600_000);
      await phases.tick();
      const after = getPhase(db, ph.id)!;
      expect(after.record.observation?.outcome).toBe("failure");
      expect(after.record.observation!.reverted.join(" ")).toContain("piece1");
      expect(after.record.acceptance?.accepted).toBe(true);
      expect(after.state).toBe("closed");
      expect(listParts(db, ph.id).some((part) => part.kind === "observation")).toBe(true);
      // Eight days out: not observed again — the last observation stands and nothing new is booked.
      vi.setSystemTime(Date.now() + 7 * 86_400_000);
      await phases.tick();
      expect(getPhase(db, ph.id)!.record.observation?.outcome).toBe("failure");
      expect(listParts(db, ph.id).filter((part) => part.kind === "observation")).toHaveLength(2);
    } finally { vi.useRealTimers(); }
    // The pure outcome: mid-window without reverts is incomplete; the first pass after the window ends the watch with no_failure,
    // and a watch that has its final outcome is not owed another pass.
    const day = 86_400_000;
    const midway = observationOutcome(0, 2 * day, { reverted: [], readable: true });
    expect(midway.outcome).toBe("incomplete");
    expect(observationDue(0, 8 * day, midway)).toBe(true);
    const ended = observationOutcome(0, 8 * day, { reverted: [], readable: true });
    expect(ended.outcome).toBe("no_failure");
    expect(observationDue(0, 8 * day, ended)).toBe(false);
    expect(observationDue(0, 8 * day, undefined)).toBe(false);
  });
});
