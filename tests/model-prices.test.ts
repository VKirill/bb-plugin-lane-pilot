import { describe, expect, it } from "vitest";
import { MODEL_PRICES, PRICES_CHECKED_AT, costUsd, priceFor } from "../src/model-prices";

describe("priceFor", () => {
  it("strips a trailing [..] suffix and a -YYYYMMDD snapshot suffix", () => {
    expect(priceFor("claude-opus-5-5[1m]")).toEqual(MODEL_PRICES["claude-opus-5-5"]);
    expect(priceFor("claude-opus-5[1m]")).toEqual(MODEL_PRICES["claude-opus-5"]);
    expect(priceFor("claude-opus-5-5-20260301")).toEqual(MODEL_PRICES["claude-opus-5-5"]);
    expect(priceFor("gpt-6.1-sol-20261006")).toEqual(MODEL_PRICES["gpt-6.1-sol"]);
    expect(priceFor("claude-opus-5-5-20260301[1m]")).toEqual(MODEL_PRICES["claude-opus-5-5"]);
  });

  it("returns null for unknown models", () => {
    expect(priceFor("gpt-5")).toBeNull();
    expect(priceFor("opus")).toBeNull();
  });

  it("has list prices for the 2026-10-06 table", () => {
    expect(PRICES_CHECKED_AT).toBe("2026-10-06");
    expect(MODEL_PRICES["claude-opus-5-5"]).toEqual({ input: 4, cacheRead: 0.2, output: 20 });
    expect(MODEL_PRICES["claude-opus-5"]).toEqual({ input: 5, cacheRead: 0.5, output: 25 });
    expect(MODEL_PRICES["claude-sonnet-5"]).toEqual({ input: 2, cacheRead: 0.2, output: 10 });
    expect(MODEL_PRICES["claude-sonnet-5-5"]).toEqual({ input: 2, cacheRead: 0.2, output: 10 });
    expect(MODEL_PRICES["claude-fable-5-1"]).toEqual({ input: 10, cacheRead: 0.25, output: 50 });
    expect(MODEL_PRICES["claude-haiku-4-5"]).toEqual({ input: 1, cacheRead: 0.1, output: 5 });
    expect(MODEL_PRICES["gpt-6-astra"]).toEqual({ input: 10, cacheRead: 1, output: 50 });
    expect(MODEL_PRICES["gpt-6.1-sol"]).toEqual({ input: 2, cacheRead: 0.1, output: 10 });
    expect(MODEL_PRICES["gpt-6-luna"]).toEqual({ input: 0.1, cacheRead: 0.01, output: 0.5 });
    expect(MODEL_PRICES["gpt-6-sol"]).toEqual({ input: 2, cacheRead: 0.2, output: 10 });
    expect(MODEL_PRICES["gpt-5.6-sol"]).toEqual({ input: 4, cacheRead: 0.4, output: 20 });
    expect(MODEL_PRICES["gpt-5.6-terra"]).toEqual({ input: 2, cacheRead: 0.2, output: 12 });
    expect(MODEL_PRICES["gpt-5.6-luna"]).toEqual({ input: 0.2, cacheRead: 0.02, output: 1.2 });
  });
});

describe("costUsd", () => {
  it("bills uncached input, cache reads, and output once per 1M", () => {
    expect(costUsd("claude-opus-5-5", { input: 1_000_000, cached: 200_000, output: 50_000 })).toBeCloseTo(
      (800_000 * 4 + 200_000 * 0.2 + 50_000 * 20) / 1_000_000,
      10,
    );
  });

  it("does not bill cached tokens at the input price and does not add output twice", () => {
    const usage = { input: 100, cached: 40, output: 10 };
    const priced = costUsd("claude-opus-5-5", usage);
    const doubleCachedAsInput = (100 * 4 + 40 * 0.2 + 10 * 20) / 1_000_000;
    const extraReasoningOnOutput = (60 * 4 + 40 * 0.2 + 20 * 20) / 1_000_000;
    expect(priced).toBeCloseTo((60 * 4 + 40 * 0.2 + 10 * 20) / 1_000_000, 10);
    expect(priced).not.toBeCloseTo(doubleCachedAsInput, 10);
    expect(priced).not.toBeCloseTo(extraReasoningOnOutput, 10);
  });

  it("returns null for an unknown model", () => {
    expect(costUsd("gpt-5", { input: 100, cached: 0, output: 10 })).toBeNull();
  });
});
