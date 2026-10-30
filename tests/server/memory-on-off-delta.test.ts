import { describe, expect, it } from "vitest";
import { memoryOnOffDelta } from "../../src/rooms/bench/memory-delta";

describe("memory on/off delta", () => {
  it("subtracts accepted tasks with memory off from accepted tasks with memory on", () => {
    expect(memoryOnOffDelta(7, 4)).toBe(3);
    expect(memoryOnOffDelta(4, 7)).toBe(-3);
  });
});
