import { CronExpressionParser } from "cron-parser";
import { describe, expect, it } from "vitest";
import { fireTimes, nextFire, offsetAt, parseDelay, scheduleTimeProblem } from "../../src/rooms/schedule/time";

const iso = (ms: number) => new Date(ms).toISOString();
const at = (text: string) => Date.parse(text);

describe("fire times", () => {
  it("agrees with cron-parser in zones without a clock change", () => {
    const crons = ["* * * * *", "*/7 * * * *", "0 9 * * 1-5", "30 4 1,15 * *", "0 0 * * 0", "0 */6 * * *", "5 8 29 * *", "0 12 10 * 3"];
    for (const zone of ["UTC", "Asia/Kolkata"]) for (const cron of crons) {
      const start = at("2026-01-03T05:31:10Z");
      const parser = CronExpressionParser.parse(cron, { currentDate: new Date(start), tz: zone });
      const expected = Array.from({ length: 12 }, () => parser.next().toDate().getTime());
      expect(fireTimes(cron, zone, start, { limit: 12 }).map(iso), `${zone} ${cron}`).toEqual(expected.map(iso));
    }
  });

  it("is strictly after the start and finds the next day", () => {
    expect(iso(nextFire("0 9 * * *", "UTC", at("2026-05-01T09:00:00Z"))!)).toBe("2026-05-02T09:00:00.000Z");
    expect(iso(nextFire("0 9 * * *", "UTC", at("2026-05-01T08:59:59Z"))!)).toBe("2026-05-01T09:00:00.000Z");
  });

  it("combines day of month and day of week with OR when both are set", () => {
    const list = fireTimes("0 0 13 * 5", "UTC", at("2026-02-01T00:00:00Z"), { limit: 4 }).map((ms) => iso(ms).slice(0, 10));
    expect(list).toEqual(["2026-02-06", "2026-02-13", "2026-02-20", "2026-02-27"]);
  });

  it("waits for a leap day", () => {
    expect(iso(nextFire("0 0 29 2 *", "UTC", at("2026-03-01T00:00:00Z"))!)).toBe("2028-02-29T00:00:00.000Z");
  });

  it("refuses what is not a cron or a zone", () => {
    expect(scheduleTimeProblem("* * * *", "UTC")).toMatch(/5 fields/);
    expect(scheduleTimeProblem("* * * * *", "Mars/Base")).toMatch(/not a time zone/);
    expect(scheduleTimeProblem("0 9 * * *", "Europe/Madrid")).toBeNull();
    expect(() => fireTimes("nope", "UTC", 0)).toThrow();
  });
});

describe("Europe/Madrid clock changes", () => {
  const zone = "Europe/Madrid";
  it("reads the zone's offsets", () => {
    expect(offsetAt(at("2026-01-15T12:00:00Z"), zone)).toBe(3_600_000);
    expect(offsetAt(at("2026-07-15T12:00:00Z"), zone)).toBe(7_200_000);
  });

  it("a daily 09:00 keeps its local hour across both changes", () => {
    const march = fireTimes("0 9 * * *", zone, at("2026-03-27T12:00:00Z"), { limit: 4 }).map(iso);
    expect(march).toEqual(["2026-03-28T08:00:00.000Z", "2026-03-29T07:00:00.000Z", "2026-03-30T07:00:00.000Z", "2026-03-31T07:00:00.000Z"]);
    const october = fireTimes("0 9 * * *", zone, at("2026-10-23T12:00:00Z"), { limit: 4 }).map(iso);
    expect(october).toEqual(["2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z", "2026-10-27T08:00:00.000Z"]);
  });

  it("a fixed time in the skipped hour runs once, shifted past the gap (spring forward 2026-03-29)", () => {
    const list = fireTimes("30 2 * * *", zone, at("2026-03-27T12:00:00Z"), { limit: 3 }).map(iso);
    // 03-28 02:30 CET, 03-29 has no 02:30: 03:30 CEST, 03-30 02:30 CEST
    expect(list).toEqual(["2026-03-28T01:30:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-30T00:30:00.000Z"]);
  });

  it("a fixed time in the repeated hour runs once, the first time (fall back 2026-10-25)", () => {
    const list = fireTimes("30 2 * * *", zone, at("2026-10-24T12:00:00Z"), { limit: 3 }).map(iso);
    expect(list).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z", "2026-10-27T01:30:00.000Z"]);
    expect(fireTimes("30 2 * * *", zone, at("2026-10-24T22:00:00Z"), { untilMs: at("2026-10-25T22:00:00Z"), limit: 5 })).toHaveLength(1);
  });

  it("an hourly schedule follows real time: twice in the repeated hour, never in the skipped one", () => {
    const back = fireTimes("0 * * * *", zone, at("2026-10-24T22:30:00Z"), { untilMs: at("2026-10-25T04:00:00Z"), limit: 20 }).map(iso);
    expect(back).toEqual(["2026-10-24T23:00:00.000Z", "2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z", "2026-10-25T02:00:00.000Z", "2026-10-25T03:00:00.000Z", "2026-10-25T04:00:00.000Z"]);
    const forward = fireTimes("0 * * * *", zone, at("2026-03-28T23:30:00Z"), { untilMs: at("2026-03-29T03:00:00Z"), limit: 20 }).map(iso);
    expect(forward).toEqual(["2026-03-29T00:00:00.000Z", "2026-03-29T01:00:00.000Z", "2026-03-29T02:00:00.000Z", "2026-03-29T03:00:00.000Z"]);
  });

  it("every 15 minutes gives 4 per real hour through the change", () => {
    const back = fireTimes("*/15 * * * *", zone, at("2026-10-24T23:59:00Z"), { untilMs: at("2026-10-25T03:00:00Z"), limit: 100 });
    expect(back).toHaveLength(13);
    expect(back.every((ms, index) => index === 0 || ms - back[index - 1]! === 15 * 60_000)).toBe(true);
  });
});

describe("southern hemisphere clock changes", () => {
  it("Australia/Sydney: spring forward on 2026-10-04 and fall back on 2026-04-05", () => {
    const zone = "Australia/Sydney";
    expect(fireTimes("30 2 * * *", zone, at("2026-10-02T12:00:00Z"), { limit: 3 }).map(iso))
      .toEqual(["2026-10-02T16:30:00.000Z", "2026-10-03T16:30:00.000Z", "2026-10-04T15:30:00.000Z"]);
    // 04-05 02:30 happens twice (AEDT then AEST): one run, the first.
    const april = fireTimes("30 2 * * *", zone, at("2026-04-03T12:00:00Z"), { limit: 3 }).map(iso);
    expect(april).toEqual(["2026-04-03T15:30:00.000Z", "2026-04-04T15:30:00.000Z", "2026-04-05T16:30:00.000Z"]);
    expect(fireTimes("30 2 * * *", zone, at("2026-04-04T12:00:00Z"), { untilMs: at("2026-04-05T12:00:00Z"), limit: 5 })).toHaveLength(1);
  });

  it("Australia/Lord_Howe shifts by half an hour", () => {
    const list = fireTimes("15 2 * * *", "Australia/Lord_Howe", at("2026-10-02T12:00:00Z"), { limit: 3 }).map(iso);
    // 10-03 02:15 LHST (+10:30); 10-04 02:15 is skipped (02:00 -> 02:30): 02:45 LHDT (+11:00); 10-05 02:15 LHDT.
    expect(list).toEqual(["2026-10-02T15:45:00.000Z", "2026-10-03T15:45:00.000Z", "2026-10-04T15:15:00.000Z"]);
  });

  it("Pacific/Auckland: a daily 09:00 holds across the change", () => {
    const list = fireTimes("0 9 * * *", "Pacific/Auckland", at("2026-09-25T12:00:00Z"), { limit: 3 }).map(iso);
    expect(list).toEqual(["2026-09-25T21:00:00.000Z", "2026-09-26T20:00:00.000Z", "2026-09-27T20:00:00.000Z"]);
  });
});

describe("delays", () => {
  it("reads English and Russian forms", () => {
    expect(parseDelay("2h")).toBe(2 * 3_600_000);
    expect(parseDelay("in 90 minutes")).toBe(90 * 60_000);
    expect(parseDelay("через 2 ч")).toBe(2 * 3_600_000);
    expect(parseDelay("1d")).toBe(86_400_000);
    expect(parseDelay("soon")).toBeNull();
    expect(parseDelay("0m")).toBeNull();
  });
});
