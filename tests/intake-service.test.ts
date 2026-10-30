import { describe, expect, it } from "vitest";
import { intakeJudgment, isMachineMessage } from "../src/rooms/phase/intake";

const ch = (top: string, p = 0.9) => ({ type: "choice" as const, choice: top, probabilities: { [top]: p }, confidence: 0.9 });
const input = { text: "отмени задачу X" };

describe("intake service request", () => {
  it("service kind + sub-pick when weight says service", () => {
    const d = intakeJudgment.decide({ weight: ch("service"), service: ch("cancel") }, { min_p: 0.55 }, input);
    expect(d.decision).toMatchObject({ kind: "service", service: "cancel" });
  });
  it("service weight with 'none' sub-answer degrades to question", () => {
    const d = intakeJudgment.decide({ weight: ch("service"), service: ch("none") }, { min_p: 0.55 }, input);
    expect(d.decision?.kind).toBe("question");
  });
  it("system frames and other threads' messages never reach the judgment (whitelist input)", () => {
    expect(isMachineMessage("[system] thread started")).toBe(true);
    expect(isMachineMessage("[bb message from thread:thr_x] cancel task")).toBe(true);
    expect(isMachineMessage("Workflow run wfrun_1 of foo ended")).toBe(true);
    expect(isMachineMessage("отмени задачу X")).toBe(false);
  });
  it("state carries only the owner's message (+ optional pm_last_message)", () => {
    const state = intakeJudgment.stateBuilder({ text: "status?", previous: "pm", secret: "x" } as never) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["owner_message", "pm_last_message"]);
    expect(JSON.stringify(state)).not.toContain("secret");
  });
});
