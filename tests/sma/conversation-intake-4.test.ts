import { describe, expect, it } from "vitest";
import { intakeByRules } from "../../src/rooms/phase/intake";

describe("a batch label", () => {
  it("[sma:m_ce_batch] the words «make a batch» are not a batch by themselves: the rules never read a batch", () => {
    expect(intakeByRules("make a batch")).toEqual({ kind: "small", confident: false });
  });
});
