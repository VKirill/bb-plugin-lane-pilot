import { afterEach, describe, expect, it } from "vitest";
import { atLeastHigh } from "../src/rooms/lead/logic";
import { landingWordAsked, ownerWordsMode, ownerWordsOn } from "../src/rooms/tasks";

// SMA person steps (map 481d75c2: Authorized by a person, Issue gate, Person accepts the wave, Plan row awaits a word): the owner asked
// for Lane Pilot one in one with SMA, its person steps included (2026-10-29). Since 2026-11-14 the default is `sensitive`: his word only for
// money, database changes and a production deploy (tests/owner-words-sensitive.test.ts); `on`, `risky` and `off` work as they did.
describe("the owner's word by default and on the older modes", () => {
  const before = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  afterEach(() => { if (before === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = before; });

  it("[sma:ta_authorized] the default is sensitive; a project may turn the word on for every step, to risky, or off", () => {
    delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
    expect(ownerWordsMode({})).toBe("sensitive");
    expect(ownerWordsMode({ "owner.words": "nonsense" })).toBe("sensitive");
    // A person step with no evidence of money, data or production does not ask by default; every step asks on on and risky, none on off.
    expect(ownerWordsOn({})).toBe(false);
    expect(ownerWordsOn({ "owner.words": "on" })).toBe(true);
    expect(ownerWordsOn({ "owner.words": "risky" })).toBe(true);
    expect(ownerWordsOn({ "owner.words": "off" })).toBe(false);
    expect(ownerWordsOn({ "owner.words": "off" }, { text: ["Change the payment provider"] })).toBe(false);
  });

  // A two-test fix waited hours for the owner's «да» and held its area (SelfyStudio worker-flaky-port-tests.2, 2026-10-31); `risky` keeps
  // the word for risk high or critical, `on` keeps every landing waiting, `off` none.
  it("asks the landing word for risk high on risky, for every task on «on», for none on «off»", () => {
    delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
    expect(landingWordAsked({ "owner.words": "risky" }, "high")).toBe(true);
    expect(landingWordAsked({ "owner.words": "risky" }, "medium")).toBe(false);
    expect(landingWordAsked({ "owner.words": "risky" }, "low")).toBe(false);
    expect(landingWordAsked({ "owner.words": "on" }, "low")).toBe(true);
    expect(landingWordAsked({ "owner.words": "off" }, "high")).toBe(false);
    // The default asks for no risk by itself.
    expect(landingWordAsked({}, "high")).toBe(false);
    process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = "off";
    expect(landingWordAsked({}, "high")).toBe(false);
    process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = "risky";
    expect(landingWordAsked({}, "high")).toBe(true);
  });

  // [SWE-2 F-003] `critical` is `high` and more, never less: it waits for the word under `risky` and counts as high wherever the
  // code asks atLeastHigh.
  it("treats a critical risk like a high one: the word is asked on risky, and atLeastHigh holds", () => {
    expect(landingWordAsked({ "owner.words": "risky" }, "critical")).toBe(true);
    expect(landingWordAsked({ "owner.words": "off" }, "critical")).toBe(false);
    expect(atLeastHigh("critical")).toBe(true);
    expect(atLeastHigh("high")).toBe(true);
    expect(atLeastHigh("medium")).toBe(false);
    expect(atLeastHigh("low")).toBe(false);
    expect(atLeastHigh(null)).toBe(false);
  });
});
