import { afterEach, describe, expect, it } from "vitest";
import { ownerWordsOn } from "../src/rooms/tasks";

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
});
