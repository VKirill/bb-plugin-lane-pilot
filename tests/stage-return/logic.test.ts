import { describe, expect, it } from "vitest";
import { RETURN_FROM, RETURN_STAGES, returnAffected, TASK_STAGE_ORDER, type ReceiptSummary } from "@lane-pilot/contracts";
import { checkNote, NOTE_MAX, pmReturnMessage, renderReturnNotes, returnTurnPrompt } from "../../src/rooms/stage-return/logic";

const chain = (states: Record<string, string> = {}): ReceiptSummary[] => TASK_STAGE_ORDER.map((stage) => ({ stage, state: states[stage] ?? "passed", inputSha256: "a".repeat(64) }));

describe("returnAffected", () => {
  it("names every stage from the one returned to as stale and the stages before it as reused", () => {
    const planning = returnAffected(chain(), "planning");
    expect(planning.from).toBe(RETURN_FROM.planning);
    expect(planning.reused).toEqual(["pm-read"]);
    expect(planning.stale.map((row) => row.stage)).toEqual(["plan-critique", "specialist-review", "writer-agent", "verification", "code-critique", "plan-fact", "acceptance-receipt"]);
    expect(planning.stale[0]!.why).toBe("returned to planning");
    expect(planning.mode).toBe("rerun");
  });
  it("discussion reuses nothing, writer reuses everything before the writer", () => {
    expect(returnAffected(chain(), "discussion").reused).toEqual([]);
    expect(returnAffected(chain(), "writer").reused).toEqual(["pm-read", "plan-critique", "specialist-review"]);
  });
  it("a stage before the target that did not pass is stale on its own account", () => {
    const result = returnAffected(chain({ "plan-critique": "failed" }), "writer");
    expect(result.from).toBe("plan-critique");
    expect(result.reused).toEqual(["pm-read"]);
  });
  it("knows exactly the three stages the person can name", () => {
    expect([...RETURN_STAGES]).toEqual(["discussion", "planning", "writer"]);
  });
});

describe("the note", () => {
  it("is trimmed, and refused when empty or too long", () => {
    expect(checkNote("  use the helper  ")).toEqual({ ok: true, note: "use the helper" });
    expect(checkNote("   ")).toMatchObject({ ok: false });
    expect(checkNote(undefined)).toMatchObject({ ok: false });
    expect(checkNote("x".repeat(NOTE_MAX + 1))).toMatchObject({ ok: false });
  });
  it("goes into the writer's brief and the writer's turn word for word, with who and when", () => {
    const text = renderReturnNotes([{ at: Date.UTC(2026, 9, 22, 12, 0, 0), to: "planning", by: "owner", note: "Export as CSV." }]);
    expect(text).toContain("Export as CSV.");
    expect(text).toContain('stage="planning" by="owner" at="2026-10-22T12:00:00.000Z"');
    expect(renderReturnNotes([])).toBe("");
    expect(returnTurnPrompt("Export as CSV.")).toContain("Export as CSV.");
  });
  it("gives the PM the note, the stale and kept stages and what to do for the stages it does itself", () => {
    const text = pmReturnMessage({ taskId: "T1", to: "discussion", by: "owner", note: "Drop the export.", stale: [{ stage: "pm-read" }], reused: [], stopped: "attempt a1 stopped" });
    expect(text).toContain("Drop the export.");
    expect(text).toContain("Stale receipts: pm-read. Kept: none.");
    expect(text).toContain("attempt a1 stopped");
    expect(text).toContain("lane_pilot_dispatch_writer");
  });
});
