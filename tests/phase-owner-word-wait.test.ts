import { describe, expect, it } from "vitest";
import { contextSignature, planGate, planSignature, type Phase, type PhaseRecord, type PlanItem } from "../src/rooms/phase";
import { autoDue, autoInputs } from "../src/rooms/phase/server/auto-stages";

// Full drill 2026-10-27, phases ph_cbff27e453 and ph_e096c500ec (owner.words left on): the plan critic approved the plan, the only thing the gate still
// asked for was the owner's word, and the machine ran lp.plan again and again (6 auto_started in one book) instead of waiting for the word.
const piece = (id: string, wave: number): PlanItem => ({
  id, title: id, wave, promise: { given: "an empty cell", when: "the sum runs", then: "it skips the cell" },
  task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }] } as never,
});

const approved = (ownerWords: boolean, extra: Partial<PhaseRecord> = {}): Phase => {
  const docs = [{ path: "docs/CONTEXT.md", sha256: "a".repeat(64), bytes: 120 }];
  const context = { docs, sha: contextSignature(docs), signedAt: 1, risks: { technical: "none", product: "users miss totals", operations: "none", security: "none" } };
  const items = [piece("a", 1)];
  const record: PhaseRecord = { ownerWords, context, plan: { items, contextSha: context.sha, sha: planSignature(items, context.sha), critique: { decision: "approve", by: "plan-critic" } }, ...extra };
  return { id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sums", goal: "sums are right", stage: "planning", state: "active", record, edition: 1, createdAt: 0, updatedAt: 0 } as Phase;
};

describe("an approved plan that waits only for the owner's word", () => {
  it("is refused by the gate for the word alone", () => {
    const gate = planGate(approved(true).record);
    expect(gate).toMatchObject({ ok: false });
    expect(gate.ok ? [] : gate.why).toEqual([expect.stringContaining("awaits the owner's word")]);
  });

  it("does not start the plan stage again: the word is the owner's to give, not a gap of the plan", () => {
    expect(autoDue(approved(true))).toBeNull();
  });

  it("still plans again when the gate refuses for a gap of the plan besides the word", () => {
    const phase = approved(true);
    phase.record.plan!.contextSha = "stale";
    expect(autoDue(phase)).toEqual({ kind: "plan" });
  });

  it("does not hand the word to the planner as a gap to fix", () => {
    const phase = approved(true);
    phase.record.plan!.contextSha = "stale";
    const inputs = autoInputs(phase, { kind: "plan" });
    expect(JSON.stringify(inputs.gaps)).not.toContain("owner's word");
    expect(JSON.stringify(inputs.gaps)).toContain("signed context");
  });
});
