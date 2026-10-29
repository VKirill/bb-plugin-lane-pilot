import { describe, expect, it } from "vitest";
import { PORTRAIT_SECTIONS, renderWhoami, type WhoamiRecord } from "../../src/rooms/anamnesis/whoami";
import { nextAction, type Phase, type PlanItem } from "../../src/rooms/phase/logic";
import { ANIMATOR_LAW, motionRows } from "../../src/rooms/phase/stages";

const piece = (title: string, promise: string): PlanItem => ({ id: title, title, wave: 1, promise: { given: "a screen", when: promise, then: "it holds" }, task: {} });

describe("animator and the portrait", () => {
  it("[sma:k_ag_animator] motion law is asked only for a motion piece, and it bounds feedback at 150–300 ms", () => {
    expect(motionRows([piece("HUD motion", "the panel moves"), piece("Copy", "the label stays")])).toEqual(["HUD motion"]);
    const design = (motion: string[]): Phase => ({ id: "ph", stage: "design", record: { design: { decision: "needed", motion, why: "screens" } } } as Phase);
    const facts = new Map();
    expect(nextAction(design(["hud"]), facts).text).toContain(ANIMATOR_LAW);
    expect(nextAction(design(["hud"]), facts).text).toContain("150–300 ms");
    expect(nextAction(design([]), facts).text).not.toContain("150–300 ms");
  });

  it.todo("[sma:k_ag_animator] frequent actions are not kept unanimated, and a confirmed contract is not required to carry the motion table"); // deferral:dfr_seed_skip_sma_gaps

  it("[sma:k_ag_profiler] the portrait is eight sections, each line names confidence and evidence, and a sensitive record stays out", () => {
    expect(PORTRAIT_SECTIONS).toHaveLength(8);
    const shown = renderWhoami([
      record({ id: "skill:ts", kind: "skill", title: "TypeScript", confidence: 0.9, evidenceCount: 2, evidence: [{ source: "bb-message", ref: "thread:1", at: 1_700_000_000_000, quote: "I write TypeScript" }] }),
      record({ id: "health:1", kind: "fact", title: "a private health fact", sensitivity: "sensitive", statement: "a private health fact" }),
      record({ id: "guess:1", kind: "preference", title: "maybe", status: "candidate" }),
    ], { detail: "full" });
    expect(shown.text).toContain("confidence high");
    expect(shown.text).toContain("2 evidence");
    expect(shown.text).toContain("thread:1");
    expect(shown.text).not.toContain("a private health fact");
    expect(shown.text).not.toContain("maybe");
    expect(shown.hiddenSensitive).toBe(1);
  });
});

function record(over: Partial<WhoamiRecord> & Pick<WhoamiRecord, "id" | "kind" | "title">): WhoamiRecord {
  return {
    statement: over.title, attributes: {}, sensitivity: "private", confidence: 0.5, status: "confirmed",
    firstSeen: 1, lastSeen: 1, manualAt: 0, createdAt: 1, updatedAt: 1, evidenceCount: 0, ...over,
  };
}
