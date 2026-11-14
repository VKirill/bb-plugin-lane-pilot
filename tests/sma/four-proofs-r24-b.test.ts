// Region 24 (n1661): the card says «without a human-set cap there is not one warning or deny»; ours holds a paid lane until a cap is set.
import { describe, expect, it } from "vitest";
import { moneyCapFrom, moneyHold } from "../../src/rooms/money/logic";

describe("spend book and budget window: no cap set", () => {
  it("[sma:k_lib_spend] deviation: an unset cap is 0, so a paid lane is refused with the money.cap_unset_zero reason; a subscription lane goes on; only off, a number or unlimited lets paid calls through", () => {
    const cap = moneyCapFrom({});
    expect(cap).toBe(0);
    const reason = moneyHold("anthropic", 0, cap);
    expect(reason).toMatch(/^no money cap is set: anthropic is a paid lane and stays closed/);
    expect(reason).toContain("money.cap_unset_zero=off");
    expect(moneyHold("claude-code", 0, cap)).toBeNull();
    expect(moneyHold("anthropic", 10_000, moneyCapFrom({ "money.cap_unset_zero": "off" }))).toBeNull();
    expect(moneyHold("anthropic", 10_000, moneyCapFrom({ "money.monthly_cap_usd": "unlimited" }))).toBeNull();
    expect(moneyHold("anthropic", 1, moneyCapFrom({ "money.monthly_cap_usd": 25 }))).toBeNull();
  });
});
