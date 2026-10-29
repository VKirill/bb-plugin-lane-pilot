import { describe, expect, it } from "vitest";
import { createAutoStages, autoDue } from "../../src/rooms/phase/server/auto-stages";
import { phaseToolParams } from "../../src/rooms/phase/server/tool";
import {
  STAGE_GATES, PHASE_STAGES, acceptanceLines, blindVerdict, contextSignature, designGate, discussionGate, executionGate, issuable,
  nextAction, phaseFolder, planGate, planSignature, type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";

const piece = (id: string, wave: number, extra: Record<string, unknown> = {}): PlanItem => ({
  id, title: id, wave, promise: { given: "an empty cell", when: "the sum runs", then: "it skips the cell" },
  task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], ...extra },
});

const signed = (): PhaseRecord => {
  const docs = [{ path: "docs/CONTEXT.md", sha256: "a".repeat(64), bytes: 120 }];
  return { context: { docs, sha: contextSignature(docs), signedAt: 1, risks: { value: "users miss totals", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["none"] } };
};

const planned = (items: PlanItem[]): PhaseRecord => {
  const record = signed();
  const contextSha = record.context!.sha;
  return { ...record, plan: { items, contextSha, sha: planSignature(items, contextSha), critique: { decision: "approve", by: "plan-critic", independence: { ok: true, why: "checker thr_c started after planner thr_p" } } } };
};

const phaseWith = (record: PhaseRecord, extra: Partial<Phase> = {}): Phase => ({
  id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum skips empty cells", goal: "sums are right",
  stage: "planning", state: "active", record, edition: 1, createdAt: 0, updatedAt: 0, ...extra,
});

const facts = (rows: Array<[string, Partial<TaskFact>]>) => new Map(rows.map(([id, fact]) => [id, {
  taskId: id, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", ...fact,
} as TaskFact]));

describe("phase gates", () => {
  it("[sma:p2_context] queues no plan when the context is missing or empty, and signs only the documents' own bytes", () => {
    const missing = discussionGate({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.why.join(" ")).toContain("no context documents");
    const empty = signed();
    empty.context!.docs[0]!.bytes = 0;
    const refused = discussionGate(empty);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why.join(" ")).toContain("is empty");
    const swapped = signed();
    swapped.context!.docs[0]!.sha256 = "b".repeat(64);
    const mismatch = discussionGate(swapped);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.why.join(" ")).toContain("signature does not match");
    expect(discussionGate(signed()).ok).toBe(true);
    const docs = signed().context!.docs;
    expect(contextSignature([...docs].reverse())).toBe(contextSignature(docs));
  });

  it("[sma:p2_admission] [sma:p2_doc_gate] admits a plan only on the signed context, with a matching composition and an independent pass", () => {
    const items = [piece("a", 1), piece("b", 2, { depends_on: ["a"] })];
    expect(planGate(planned(items)).ok).toBe(true);
    const otherContext = planned(items);
    otherContext.plan!.contextSha = "f".repeat(64);
    otherContext.plan!.sha = planSignature(items, otherContext.plan!.contextSha);
    const stale = planGate(otherContext);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.why.join(" ")).toContain("signed context");
    const rewritten = planned(items);
    rewritten.plan!.items = [piece("a", 1), piece("c", 2)];
    const drifted = planGate(rewritten);
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(drifted.why.join(" ")).toContain("plan signature does not match");
    const sameSession = planned(items);
    sameSession.plan!.critique!.independence = { ok: false, why: "the checker stayed in the planner's session" };
    const roles = planGate(sameSession);
    expect(roles.ok).toBe(false);
    if (!roles.ok) expect(roles.why.join(" ")).toContain("not proven independent");
  });

  it("[sma:p4_design_ready] lets execution start when the drawing is not needed, and holds it when a needed drawing is missing", () => {
    expect(designGate({ design: { decision: "not_needed", why: "no piece changes a screen" } }).ok).toBe(true);
    const waiting = designGate({ design: { decision: "needed", why: "screens" } });
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) expect(waiting.why.join(" ")).toContain("no drawing");
  });

  it("[sma:p4_deps] does not issue a piece until every piece it depends on, in an earlier wave, is accepted", () => {
    const items = [piece("a", 1), piece("b", 2, { depends_on: ["a"] })];
    expect(issuable(items, {}, new Map()).map((item) => item.id)).toEqual(["a"]);
    expect(issuable(items, { a: "a" }, facts([["a", { state: "running" }]]))).toEqual([]);
    expect(issuable(items, { a: "a" }, facts([["a", {}]])).map((item) => item.id)).toEqual(["b"]);
  });

  it("[sma:p4_waits] [sma:p5_all_plans] keeps the phase in execution until every piece is issued and accepted", () => {
    const items = [piece("a", 1), piece("b", 1)];
    const half = executionGate(items, { a: "a" }, facts([["a", {}]]));
    expect(half.ok).toBe(false);
    if (!half.ok) expect(half.why.join(" ")).toContain("b is not issued yet");
    const open = executionGate(items, { a: "a", b: "b" }, facts([["a", {}], ["b", { state: "running" }]]));
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.why.join(" ")).toContain("b is running");
    expect(executionGate(items, { a: "a", b: "b" }, facts([["a", {}], ["b", {}]])).ok).toBe(true);
  });

  it("[sma:p5_blind] [sma:p5_blind_wall] decides the verdict from the pieces' receipts, and the same receipts freeze the same verdict", () => {
    const items = [piece("a", 1)];
    const proved = facts([["a", {}]]);
    const goal = { state: "passed", headSha: "abc123", detail: null };
    const first = blindVerdict(items, proved, goal, 10);
    const again = blindVerdict(items, proved, goal, 10);
    expect(first.state).toBe("passed");
    expect(again.inputSha).toBe(first.inputSha);
    expect(first.detail).not.toMatch(/writer|said|story/i);
    const lied = facts([["a", { planFact: "failed" }]]);
    const refused = blindVerdict(items, lied, goal, 10);
    expect(refused.state).toBe("failed");
    expect(refused.detail).toContain("plan-fact failed");
    expect(refused.inputSha).not.toBe(first.inputSha);
  });

  it("[sma:p5_main_same] holds acceptance when main is no longer the commit the verdict saw", () => {
    const record = planned([piece("a", 1)]);
    record.plan!.admittedSha = record.plan!.sha;
    record.verification = { verdict: { state: "passed", detail: "proved", mainSha: "a".repeat(40), at: 1, inputSha: "b".repeat(64) }, model: { state: "met", by: "audit", summary: "met", at: 2 } };
    const phase = phaseWith(record, { stage: "acceptance" });
    const moved = acceptanceLines(phase, facts([["a", {}]]), { mainSha: "c".repeat(40), openDeferrals: 0 }).find((line) => line.id === "main_unmoved");
    expect(moved).toMatchObject({ ok: false });
    expect(moved!.detail).toContain("main moved");
    const same = acceptanceLines(phase, facts([["a", {}]]), { mainSha: "a".repeat(40), openDeferrals: 0 }).find((line) => line.id === "main_unmoved");
    expect(same).toMatchObject({ ok: true });
  });

  it("[sma:pc_home] keeps a phase's files under .agents/phases/<id>", () => {
    expect(phaseFolder("ph_abc")).toBe(".agents/phases/ph_abc");
    expect(phaseFolder("ph_abc")).not.toBe(phaseFolder("ph_other"));
  });

  it("[sma:pc_no_gates] names a gate for every stage a phase can be in", () => {
    const open = PHASE_STAGES.filter((stage) => stage !== "closed");
    expect(Object.keys(STAGE_GATES).sort()).toEqual([...open].sort());
    for (const stage of open) expect(STAGE_GATES[stage].length).toBeGreaterThan(0);
  });

  it("[sma:pc_no_auto] refuses a phase command that carries a flag deciding for the person", () => {
    for (const flag of ["force", "skip", "auto", "noGates"] as const) {
      const parsed = phaseToolParams.safeParse({ action: "pause", phaseId: "ph_1", [flag]: true });
      expect(parsed.success, flag).toBe(false);
    }
    expect(phaseToolParams.safeParse({ action: "pause", phaseId: "ph_1" }).success).toBe(true);
  });

  it("[sma:cg_phase_pause] tells the PM a paused phase is paused and does not ask it to issue work", () => {
    const phase = phaseWith(planned([piece("a", 1)]), { stage: "execution", state: "paused" });
    const action = nextAction(phase, new Map());
    expect(action.waitsForPm).toBe(false);
    expect(action.text).toContain("is paused");
    expect(action.text).not.toContain("issues the next wave");
  });

  it("[sma:pc_live] does not start a second stage workflow while one is still running", async () => {
    const phase = phaseWith({}, { stage: "discussion", record: { auto: { kind: "analyze", wfRunId: "wf-live", startedAt: 1 } } });
    const starts: string[] = [];
    const { step } = createAutoStages({ log: () => {} }, {
      workflowEngine: {
        get: () => ({ status: "running" }),
        start: () => { starts.push("start"); return { runId: "wf-new", done: Promise.resolve() }; },
      },
    } as never, {
      api: {} as never, exhausted: async () => {}, get: () => phase, save: () => {}, book: () => {},
      writeDocs: async () => ({ written: [] }), runtime: () => ({}), pmIdle: async () => true, now: () => 1,
    });
    expect(await step(phase)).toBe(true);
    expect(starts).toEqual([]);
    expect(autoDue({ ...phase, state: "paused", record: {} })).toBeNull();
    expect(autoDue({ ...phase, state: "active", record: {} })).toEqual({ kind: "analyze" });
  });

  it.todo("[sma:p5_record_after] UAT is written at acceptance, not only after the phase is in main; the card's proof points at the regression schedule");
  it.todo("[sma:pc_folder] a number or a folder name resolves to one phase and an ambiguous name is refused; the card's proof points at writePhaseBook");
  it.todo("[sma:k_lib_pkgcheck] publishable() checks version, changelog, a clean tree, LICENSE and the atlas, not bin files or a badge receipt");
  it.todo("[sma:p6_observe] the regression window defaults to 14 days, not seven, and the pass never reverts an acceptance");
});
