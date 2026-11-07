import { describe, expect, it } from "vitest";
import { intakeByRules, intakeJudgment } from "../../src/rooms/phase/intake";

describe("a batch label", () => {
  it("[sma:m_ce_batch] the words «make a batch» are not a batch by themselves; a judgment that says batch is kept", () => {
    expect(intakeByRules("make a batch")).toEqual({ kind: "small", confident: false });
    const decided = intakeJudgment.decide(
      { weight: { type: "choice", probabilities: { batch: 0.9, small: 0.05, reply: 0.05 } } } as never,
      { min_p: 0.55 },
      { text: "make a batch" },
    );
    expect(decided.decision?.kind).toBe("batch");
  });

});
