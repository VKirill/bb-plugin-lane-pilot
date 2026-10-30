import { describe, expect, it } from "vitest";
import { logFindJudgment } from "@lane-pilot/jev/judgments/log-find";

const input = { task: "t", command: "npm test", lines: ["ok", "Error: boom", "done"] };
const ch = (top: string) => ({ type: "choice" as const, choice: top, probabilities: { [top]: 0.9 }, confidence: 0.9 });
const n = (v: number) => ({ type: "noul" as const, noul: v });

describe("logs.error_find", () => {
  it("returns the picked line only when the log holds an answer", () => {
    const yes = logFindJudgment.decide({ answer: n(0.9), which: ch("l1") }, { answer_p: 0.6 }, input);
    expect(yes.decision).toEqual({ line: 1, hasAnswer: true });
    const no = logFindJudgment.decide({ answer: n(0.2), which: ch("l1") }, { answer_p: 0.6 }, input);
    expect(no.decision).toEqual({ line: null, hasAnswer: false });
  });
  it("whitelist state", () => {
    const state = logFindJudgment.stateBuilder({ ...input, secret: "sk-x" } as never) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["command", "lines", "task"]);
    expect(JSON.stringify(state)).not.toContain("sk-x");
  });
});
