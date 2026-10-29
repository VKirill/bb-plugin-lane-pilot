import { describe, expect, it } from "vitest";
import {
  PLAN_WORD_GAP, acceptanceLines, designGate, discussionGate, executionGate, lessonsNeeded, pieceProblems, planGate, planSignature,
  waveProblems, contextSignature, type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";

const piece = (id: string, wave: number, extra: Record<string, unknown> = {}): PlanItem => ({
  id, title: id, wave, promise: { given: "an empty cell", when: "the sum runs", then: "it skips the cell" },
  task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], acceptance: ["works"], ...extra },
});

const signed = (): PhaseRecord => {
  const docs = [{ path: "docs/CONTEXT.md", sha256: "a".repeat(64), bytes: 80 }];
  return { context: { docs, sha: contextSignature(docs), signedAt: 1, risks: { value: "missed totals", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["none"] } };
};

const planned = (items: PlanItem[], extra: Partial<PhaseRecord> = {}): PhaseRecord => {
  const record = { ...signed(), ...extra };
  const contextSha = record.context!.sha;
  return { ...record, plan: { items, contextSha, sha: planSignature(items, contextSha), admittedSha: planSignature(items, contextSha), critique: { decision: "approve", by: "critic", independence: { ok: true, why: "separate session" } } } };
};

const phaseOf = (record: PhaseRecord): Phase => ({
  id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sums", goal: "sums are right",
  stage: "acceptance", state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});

const facts = (rows: Array<[string, Partial<TaskFact>]>) => new Map(rows.map(([id, fact]) => [id, {
  taskId: id, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", ...fact,
} as TaskFact]));

const line = (phase: Phase, id: string, rows: Array<[string, Partial<TaskFact>]> = [["a", {}]], now: { mainSha: string | null; openDeferrals: number; noTerm?: Array<{ id: string; what: string }> } = { mainSha: null, openDeferrals: 0 }) =>
  acceptanceLines(phase, facts(rows), now).find((row) => row.id === id)!;

describe("phase checks", () => {
  it("[sma:p1_validate] [sma:p1_docs_ready] refuses a discussion card that is missing a field or an empty document", () => {
    const bare = discussionGate({});
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.why.join(" ")).toMatch(/no context documents|risks not named|no appetite|no-gos/);
    const noAppetite = signed();
    noAppetite.context!.appetite = "  ";
    const refused = discussionGate(noAppetite);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why.join(" ")).toContain("no appetite");
    const empty = signed();
    empty.context!.docs[0]!.bytes = 0;
    expect(discussionGate(empty).ok).toBe(false);
    expect(discussionGate(signed()).ok).toBe(true);
  });

  it("[sma:p2_waves] refuses a plan whose waves cannot be computed", () => {
    const later = waveProblems([piece("a", 2), piece("b", 1, { depends_on: ["a"] })]);
    expect(later[0]).toContain("earlier wave");
    const missing = waveProblems([piece("a", 1, { depends_on: ["gone"] })]);
    expect(missing[0]).toContain("not in the plan");
    expect(waveProblems([piece("a", 1), piece("b", 2, { depends_on: ["a"] })])).toEqual([]);
  });

  it("[sma:p2_issue_troubles] refuses a piece that cannot become a work", () => {
    expect(pieceProblems(piece("a", 1, { id: "other" })).join(" ")).toContain("task id must equal");
    expect(pieceProblems(piece("a", 1, { owns_paths: [] })).join(" ")).toContain("no owns_paths");
    expect(pieceProblems(piece("a", 1, { verification: [] })).join(" ")).toContain("no verification command");
    expect(pieceProblems(piece("a", 1))).toEqual([]);
  });

  it("[sma:p2_signed_input] [sma:p2_complete] [sma:p2_row_awaits] reads the signed edition first and waits for the owner's word when it is asked", () => {
    const items = [piece("a", 1)];
    expect(planGate(planned(items)).ok).toBe(true);
    const unread = planned(items);
    unread.plan!.contextSha = "c".repeat(64);
    unread.plan!.sha = planSignature(items, unread.plan!.contextSha);
    const gate = planGate(unread);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.why.join(" ")).toContain("signed context");
    const waiting = planGate(planned(items, { ownerWords: true }));
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) expect(waiting.why).toContain(PLAN_WORD_GAP);
  });

  it("[sma:p3_review] [sma:p3_readiness] [sma:pc_roles_judge] holds a drawing until a different role has reviewed it", () => {
    const drawing = { paths: [".agents/phases/ph_1/design/UI-SPEC.md"], sha256: "d", designer: "design-lead", feasible: true, reviewer: "design-lead" };
    const same = designGate({ design: { decision: "needed", why: "screens", drawing } });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.why.join(" ")).toContain("separate role");
    const ready = designGate({ design: { decision: "needed", why: "screens", drawing: { ...drawing, reviewer: "ui-review" } } });
    expect(ready.ok).toBe(true);
  });

  it("[sma:p4_complete] reports a blocked piece instead of treating it as handed in", () => {
    const held = executionGate([piece("a", 1)], { a: "a" }, facts([["a", { state: "blocked" }]]));
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.why.join(" ")).toContain("a is blocked");
    expect(executionGate([piece("a", 1)], { a: "a" }, facts([["a", {}]])).ok).toBe(true);
  });

  it("[sma:p6_calc] [sma:p6_l_contract] [sma:p6_l_promise] [sma:p6_l_regression] [sma:p6_l_landing] [sma:p6_closure] worsens a line from the piece's facts and never from a claim", () => {
    const record = planned([piece("a", 1)]);
    record.verification = { verdict: { state: "passed", detail: "proved", mainSha: null, at: 1, inputSha: "b".repeat(64) }, model: { state: "met", by: "audit", summary: "met", at: 2 } };
    const phase = phaseOf(record);
    const held = acceptanceLines(phase, facts([["a", {}]]), { mainSha: null, openDeferrals: 0 });
    expect(held.every((row) => row.ok)).toBe(true);
    expect(line(phase, "contract_current").ok).toBe(true);
    expect(line(phase, "promises_proved").ok).toBe(true);
    expect(line(phase, "checks_passed").ok).toBe(true);
    expect(line(phase, "landed").ok).toBe(true);
    const changed = phaseOf({ ...record, plan: { ...record.plan!, admittedSha: "e".repeat(64) } });
    expect(line(changed, "contract_current").detail).toContain("changed after its admission");
    expect(line(phase, "promises_proved", [["a", { planFact: "failed" }]]).ok).toBe(false);
    expect(line(phase, "checks_passed", [["a", { verification: "failed" }]]).detail).toContain("checks failed");
    expect(line(phase, "landed", [["a", { state: "running" }]]).detail).toContain("not merged");
    const red = acceptanceLines(phase, facts([["a", { verification: "failed" }]]), { mainSha: null, openDeferrals: 0 });
    expect(red.every((row) => row.ok)).toBe(false);
  });

  it("[sma:p6_l_limits] holds acceptance while a deferred check has no term from the owner", () => {
    const phase = phaseOf(planned([piece("a", 1)]));
    const held = line(phase, "limits_acknowledged", [["a", {}]], { mainSha: null, openDeferrals: 1, noTerm: [{ id: "def-1", what: "browser" }] });
    expect(held.ok).toBe(false);
    expect(held.detail).toContain("def-1");
    expect(line(phase, "limits_acknowledged").ok).toBe(true);
  });

  it("[sma:p7_calc] [sma:p7_events] [sma:p7_no_trigger] asks for lessons only after a return, a failed attempt or a failed verdict", () => {
    expect(lessonsNeeded({ returns: 0, failedAttempts: 0, verdictFailures: 0 })).toEqual({ needed: false, why: "the phase went through without returns or failures" });
    const needed = lessonsNeeded({ returns: 1, failedAttempts: 2, verdictFailures: 0 });
    expect(needed.needed).toBe(true);
    expect(needed.why).toContain("1 return");
    expect(needed.why).toContain("2 failed attempt");
  });
});
