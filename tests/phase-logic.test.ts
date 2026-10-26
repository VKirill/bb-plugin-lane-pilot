import { describe, expect, it } from "vitest";
import {
  GENESIS, acceptanceLines, blindVerdict, brokenLink, contextSignature, designDecision, designGate, discussionGate, executionGate, issuable, lessonsNeeded,
  nextAction, partHash, planGate, planSignature, staleAfterReturn, waveProblems, type BookPart, type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../src/rooms/phase";

const piece = (id: string, wave: number, extra: Record<string, unknown> = {}): PlanItem => ({
  id, title: id, wave, promise: { given: "an empty cell", when: "the sum runs", then: "it skips the cell" },
  task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], ...extra },
});

const signed = (): PhaseRecord => {
  const docs = [{ path: "docs/CONTEXT.md", sha256: "a".repeat(64), bytes: 120 }];
  return { context: { docs, sha: contextSignature(docs), signedAt: 1, risks: { technical: "none", product: "users miss totals", operations: "none", security: "none" } } };
};

const planned = (items: PlanItem[], decision: "approve" | "changes_requested" = "approve"): PhaseRecord => {
  const record = signed();
  const contextSha = record.context!.sha;
  return { ...record, plan: { items, contextSha, sha: planSignature(items, contextSha), critique: { decision, by: "plan-critic" } } };
};

const phaseWith = (record: PhaseRecord, stage: Phase["stage"] = "planning"): Phase => ({
  id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum skips empty cells", goal: "sums are right", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});

const facts = (rows: Array<[string, Partial<TaskFact>]>) => new Map(rows.map(([id, fact]) => [id, { taskId: id, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "skipped", ...fact } as TaskFact]));

describe("phase gates", () => {
  it("discussion needs signed, non-empty documents", () => {
    expect(discussionGate({}).ok).toBe(false);
    expect(discussionGate(signed()).ok).toBe(true);
    const empty = signed();
    empty.context!.docs[0]!.bytes = 0;
    expect(discussionGate(empty)).toMatchObject({ ok: false });
  });

  it("admits a plan only when every piece becomes a work, waves hold, it was built on the signed context and a checker approved", () => {
    expect(planGate(planned([piece("a", 1), piece("b", 2, { depends_on: ["a"] })])).ok).toBe(true);
    expect(planGate(planned([piece("a", 1)], "changes_requested")).ok).toBe(false);
    const noCheck = planned([piece("a", 1, { verification: [] })]);
    expect(planGate(noCheck)).toMatchObject({ ok: false });
    const stale = planned([piece("a", 1)]);
    stale.plan!.contextSha = "f".repeat(64);
    expect(JSON.stringify(planGate(stale))).toContain("signed context");
  });

  it("refuses a dependency on the same or a later wave and on a piece outside the plan", () => {
    expect(waveProblems([piece("a", 1), piece("b", 1, { depends_on: ["a"] })])).toHaveLength(1);
    expect(waveProblems([piece("a", 1, { depends_on: ["zz"] })])[0]).toContain("not in the plan");
  });

  it("asks for a drawing when a piece changes screens, and the drawing needs a feasibility answer and a separate reviewer", () => {
    expect(designDecision([piece("a", 1, { owns_paths: ["src/ui/Card.tsx"] })]).decision).toBe("needed");
    expect(designDecision([piece("a", 1)]).decision).toBe("not_needed");
    const record: PhaseRecord = { design: { decision: "needed", why: "", drawing: { paths: ["d.png"], sha256: "x", designer: "design-lead", feasible: true, reviewer: "design-lead" } } };
    expect(JSON.stringify(designGate(record))).toContain("separate role");
    record.design!.drawing!.reviewer = "ui-review";
    // The design contract is mandatory: the drawing carries its checkable points.
    expect(JSON.stringify(designGate(record))).toContain("UI-SPEC.md");
    record.design!.drawing!.paths.push(".agents/phases/ph_1/design/UI-SPEC.md");
    expect(designGate(record).ok).toBe(true);
  });
});

describe("execution and verification", () => {
  const items = [piece("a", 1), piece("b", 1), piece("c", 2, { depends_on: ["a"] })];

  it("issues wave by wave: the next wave only after every piece of the earlier one is accepted", () => {
    expect(issuable(items, {}, new Map()).map((item) => item.id)).toEqual(["a", "b"]);
    expect(issuable(items, { a: "a", b: "b" }, facts([["a", {}], ["b", { state: "running" }]]))).toEqual([]);
    expect(issuable(items, { a: "a", b: "b" }, facts([["a", {}], ["b", {}]])).map((item) => item.id)).toEqual(["c"]);
  });

  it("leaves execution only when every piece is issued and accepted", () => {
    expect(executionGate(items, { a: "a", b: "b" }, facts([["a", {}], ["b", {}]])).ok).toBe(false);
    expect(executionGate(items, { a: "a", b: "b", c: "c" }, facts([["a", {}], ["b", {}], ["c", {}]])).ok).toBe(true);
  });

  it("decides the blind verdict from the checks, never from the writer, and freezes it by its input", () => {
    const all = facts([["a", {}], ["b", {}], ["c", {}]]);
    const passed = blindVerdict(items, all, { state: "passed", headSha: "h1" }, 10);
    expect(passed.state).toBe("passed");
    expect(blindVerdict(items, all, { state: "passed", headSha: "h1" }, 99).inputSha).toBe(passed.inputSha);
    expect(blindVerdict(items, facts([["a", { planFact: "failed" }], ["b", {}], ["c", {}]]), { state: "passed" }, 10).state).toBe("failed");
    expect(blindVerdict(items, all, null, 10).detail).toContain("goal check has not run");
  });

  // The review's reproduction (Astra review §1): one accepted piece, plan-fact and checks skipped, the goal check still running.
  it("waits while the run's goal check is running and never calls a skipped proof proved", () => {
    const bare = [{ id: "p1" }] as unknown as PlanItem[];
    const skipped = facts([["p1", { planFact: "skipped", verification: "skipped" }]]);
    expect(blindVerdict(bare, skipped, { state: "running", headSha: "abc" }, 1).state).toBe("pending");
    expect(blindVerdict(bare, facts([["p1", {}]]), { state: "running", headSha: "abc" }, 1).state).toBe("pending");
    const promised = [piece("p1", 1, { acceptance: ["the sum skips an empty cell"], kind: "fix" })];
    const verdict = blindVerdict(promised, skipped, { state: "passed", headSha: "abc" }, 1);
    expect(verdict.state).toBe("failed");
    expect(verdict.detail).toContain("plan-fact was skipped");
    expect(verdict.detail).toContain("checks were skipped");
    // A failed piece is a verdict at once, a still running goal check does not turn it into a wait.
    expect(blindVerdict(promised, skipped, { state: "running" }, 1).state).toBe("failed");
  });

  it("keeps a piece that has nothing to cite from the diff passing: no acceptance items, or a docs, research or check piece", () => {
    const noCode = facts([["a", { planFact: "skipped" }], ["b", { planFact: "skipped" }], ["c", { planFact: "skipped" }]]);
    const items = [piece("a", 1), piece("b", 1, { acceptance: ["the note names the cause"], kind: "research" }), piece("c", 1, { acceptance: ["the doc lists the flags"], kind: "docs" })];
    expect(blindVerdict(items, noCode, { state: "passed", headSha: "h" }, 1).state).toBe("passed");
    expect(blindVerdict(items, noCode, { state: "skipped" }, 1).state).toBe("passed");
  });

  it("does not count a skipped plan-fact as a proved promise in the acceptance lines", () => {
    const code = [piece("a", 1, { acceptance: ["the sum skips an empty cell"] }), piece("b", 1)];
    const record = planned(code);
    record.plan!.admittedSha = record.plan!.sha;
    record.verification = { verdict: blindVerdict(code, facts([["a", {}], ["b", {}]]), { state: "passed", headSha: "h1" }, 1) as never, model: { state: "met", by: "lp.close", summary: "ok", at: 2 } };
    const phase = phaseWith({ ...record, execution: { issued: { a: "a", b: "b" } } }, "acceptance");
    const lines = (rows: Array<[string, Partial<TaskFact>]>) => acceptanceLines(phase, facts(rows), { mainSha: "h1", openDeferrals: 0 }).find((line) => line.id === "promises_proved")!;
    expect(lines([["a", { planFact: "skipped" }], ["b", {}]])).toMatchObject({ ok: false, detail: expect.stringContaining("a") });
    expect(lines([["a", {}], ["b", { planFact: "skipped" }]]).ok).toBe(true);
  });

  it("accepts only when every line holds, and sees main move after the verdict", () => {
    const record = planned(items);
    record.plan!.admittedSha = record.plan!.sha;
    record.verification = { verdict: blindVerdict(items, facts([["a", {}], ["b", {}], ["c", {}]]), { state: "passed", headSha: "h1" }, 1) as never, model: { state: "met", by: "lp.close", summary: "sums are right", at: 2 } };
    const phase = phaseWith({ ...record, execution: { issued: { a: "a", b: "b", c: "c" } } }, "acceptance");
    const ok = acceptanceLines(phase, facts([["a", {}], ["b", {}], ["c", {}]]), { mainSha: "h1", openDeferrals: 0 });
    expect(ok.every((line) => line.ok)).toBe(true);
    const moved = acceptanceLines(phase, facts([["a", {}], ["b", {}], ["c", {}]]), { mainSha: "h2", openDeferrals: 0 });
    expect(moved.find((line) => line.id === "main_unmoved")?.ok).toBe(false);
  });
});

describe("returns, lessons and the book", () => {
  it("a return makes everything after the target stage stale", () => {
    const record = { ...planned([piece("a", 1)]), verification: { verdict: { state: "passed" as const, detail: "", mainSha: null, at: 1, inputSha: "x" } } };
    record.plan!.admittedSha = record.plan!.sha;
    const back = staleAfterReturn("planning", record);
    expect(back.plan?.admittedSha).toBeUndefined();
    expect(back.verification).toBeUndefined();
    expect(back.context).toBeDefined();
  });

  it("needs a lessons analysis only when something went wrong", () => {
    expect(lessonsNeeded({ returns: 0, failedAttempts: 0, verdictFailures: 0 }).needed).toBe(false);
    expect(lessonsNeeded({ returns: 1, failedAttempts: 0, verdictFailures: 0 }).needed).toBe(true);
  });

  it("finds the first broken link of the book's chain", () => {
    const parts: BookPart[] = [];
    let prev = GENESIS;
    for (let seq = 1; seq <= 3; seq += 1) {
      const part = { seq, at: seq, section: "decisions" as const, kind: "stage", text: `part ${seq}` };
      const hash = partHash(prev, part);
      parts.push({ ...part, prevHash: prev, hash });
      prev = hash;
    }
    expect(brokenLink(parts)).toBeNull();
    parts[1] = { ...parts[1]!, text: "rewritten" };
    expect(brokenLink(parts)).toBe(2);
  });

  it("tells the PM one thing per stage, and the driver's own steps do not wait for the PM", () => {
    expect(nextAction(phaseWith({}, "discussion"), new Map()).waitsForPm).toBe(true);
    const execution = phaseWith({ ...planned([piece("a", 1)]), execution: { issued: { a: "a" } } }, "execution");
    expect(nextAction(execution, facts([["a", { state: "running" }]])).waitsForPm).toBe(false);
    expect(nextAction(execution, facts([["a", { state: "blocked" }]])).text).toContain("a is blocked");
  });
});
