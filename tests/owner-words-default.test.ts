import { afterEach, describe, expect, it } from "vitest";
import { atLeastHigh } from "../src/rooms/lead/logic";
import { landingWordAsked, ownerWordsMode, ownerWordsOn } from "../src/rooms/tasks";

// SMA person steps (map 481d75c2: Authorized by a person, Issue gate, Person accepts the wave, Plan row awaits a word): the owner asked
// for Lane Pilot one in one with SMA, its person steps included (2026-10-29), so owner.words is on unless a project turns it off.
describe("the owner's word by default", () => {
  const before = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  afterEach(() => { if (before === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = before; });

  it("[sma:ta_authorized] is asked when no setting says, and not when the project turns it off", () => {
    delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
    expect(ownerWordsOn({})).toBe(true);
    expect(ownerWordsOn({ "owner.words": "on" })).toBe(true);
    expect(ownerWordsOn({ "owner.words": "off" })).toBe(false);
  });

  // A two-test fix waited hours for the owner's «да» and held its area (SelfyStudio worker-flaky-port-tests.2, 2026-10-31); the owner
  // chose the word for risky tasks only: the default is `risky`, a landing waits for risk high alone, `on` keeps every landing waiting.
  it("asks the landing word for risk high only by default, for every task on «on», for none on «off»", () => {
    delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
    expect(ownerWordsMode({})).toBe("risky");
    expect(landingWordAsked({}, "high")).toBe(true);
    expect(landingWordAsked({}, "medium")).toBe(false);
    expect(landingWordAsked({}, "low")).toBe(false);
    expect(landingWordAsked({ "owner.words": "on" }, "low")).toBe(true);
    expect(landingWordAsked({ "owner.words": "off" }, "high")).toBe(false);
    expect(landingWordAsked({ "owner.words": "risky" }, "high")).toBe(true);
    process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = "off";
    expect(landingWordAsked({}, "high")).toBe(false);
  });

  // [SWE-2 F-003] `critical` is `high` and more, never less: it waits for the word under `risky` and counts as high wherever the
  // code asks atLeastHigh.
  it("treats a critical risk like a high one: the word is asked, and atLeastHigh holds", () => {
    delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
    expect(landingWordAsked({}, "critical")).toBe(true);
    expect(landingWordAsked({ "owner.words": "risky" }, "critical")).toBe(true);
    expect(landingWordAsked({ "owner.words": "off" }, "critical")).toBe(false);
    expect(atLeastHigh("critical")).toBe(true);
    expect(atLeastHigh("high")).toBe(true);
    expect(atLeastHigh("medium")).toBe(false);
    expect(atLeastHigh("low")).toBe(false);
    expect(atLeastHigh(null)).toBe(false);
  });
});
