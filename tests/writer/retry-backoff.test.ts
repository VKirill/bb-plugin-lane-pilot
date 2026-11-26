import { describe, expect, it } from "vitest";
import { failureClassCooldownMs } from "../../src/rooms/contracts/failure-class";

describe("retry backoff cooldown", () => {
  it("the pause after a repeated same-class failure doubles and stays under the cap", () => {
    expect(failureClassCooldownMs("merge", {}, 1)).toBe(30_000);
    expect(failureClassCooldownMs("merge", {}, 2)).toBe(60_000);
    expect(failureClassCooldownMs("merge", {}, 3)).toBe(120_000);
    expect(failureClassCooldownMs("infra", {}, 2)).toBe(120_000);
    expect(failureClassCooldownMs("merge", { "writer.cooldown_max_ms": 90_000 }, 3)).toBe(90_000);
    expect(failureClassCooldownMs("provider", {}, 5)).toBe(0);
  });
});
