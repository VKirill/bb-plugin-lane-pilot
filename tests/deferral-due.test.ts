import { describe, expect, it } from "vitest";
import { dayOfArg, namedDates, resolveTerm } from "../src/rooms/deferral/due";

// SMA rule 5: a term is the owner's date, read from his message. 2026-10-22 is a Thursday.
const AT = Date.parse("2026-10-22T10:00:00Z");
const days = (text: string, at = AT) => namedDates(text, at).map((item) => item.day);

describe("dates an owner's message names", () => {
  it("reads ISO, dotted and Russian or English month forms", () => {
    expect(days("срок 2026-11-05, не позже")).toEqual(["2026-11-05"]);
    expect(days("до 5.11.2026")).toEqual(["2026-11-05"]);
    expect(days("до 5.11.26")).toEqual(["2026-11-05"]);
    expect(days("отложим до 5.11")).toEqual(["2026-11-05"]);
    expect(days("давай до 5 ноября")).toEqual(["2026-11-05"]);
    expect(days("5 ноября 2027")).toEqual(["2027-11-05"]);
    expect(days("by Nov 5")).toEqual(["2026-11-05"]);
    expect(days("on 5 November 2026")).toEqual(["2026-11-05"]);
    expect(days("March 3rd")).toEqual(["2027-03-03"]);
  });

  it("puts a day and month without a year in the next such day on or after the message", () => {
    expect(days("22 октября", AT)).toEqual(["2026-10-22"]);
    expect(days("21 октября", AT)).toEqual(["2027-10-21"]);
  });

  it("counts «через N …» and «in N …» from the message's own day", () => {
    expect(days("сделаем через 14 дней")).toEqual(["2026-11-05"]);
    expect(days("через 2 недели")).toEqual(["2026-11-05"]);
    expect(days("через две недели")).toEqual(["2026-11-05"]);
    expect(days("через неделю")).toEqual(["2026-10-29"]);
    expect(days("через месяц")).toEqual(["2026-11-22"]);
    expect(days("in 3 days")).toEqual(["2026-10-25"]);
    expect(days("in two weeks")).toEqual(["2026-11-05"]);
    expect(days("завтра")).toEqual(["2026-10-23"]);
    expect(days("послезавтра")).toEqual(["2026-10-24"]);
  });

  it("takes the next such weekday after the message's day", () => {
    expect(days("до пятницы")).toEqual(["2026-10-23"]);
    expect(days("в понедельник")).toEqual(["2026-10-26"]);
    expect(days("к четвергу")).toEqual(["2026-10-29"]);
    expect(days("by Friday")).toEqual(["2026-10-23"]);
    expect(days("не позже воскресенья")).toEqual([]);
    expect(days("до воскресенья")).toEqual(["2026-10-25"]);
  });

  it("does not take versions, impossible dates or plain words for dates", () => {
    expect(days("версия 0.1.264 вышла")).toEqual([]);
    expect(days("31 ноября")).toEqual([]);
    expect(days("2026-13-40")).toEqual([]);
    expect(days("потом когда-нибудь, в целом ок")).toEqual([]);
    expect(days("может быть в пятом пункте")).toEqual([]);
  });

  it("ends the term at the last millisecond of the day", () => {
    expect(namedDates("2026-11-05", AT)[0]!.dueAt).toBe(Date.parse("2026-11-05T23:59:59.999Z"));
  });
});

describe("the term a message gives", () => {
  it("takes the one named date; several need --due; --due must be one of them", () => {
    expect(resolveTerm("отложим до 5 ноября", AT)).toMatchObject({ ok: true, term: { day: "2026-11-05", source: "explicit" } });
    expect(resolveTerm("через 14 дней", AT)).toMatchObject({ ok: true, term: { day: "2026-11-05", source: "relative" } });
    expect(resolveTerm("до пятницы", AT)).toMatchObject({ ok: true, term: { day: "2026-10-23", source: "weekday" } });
    const two = resolveTerm("либо 5 ноября, либо 20 ноября", AT);
    expect(two).toMatchObject({ ok: false });
    expect(!two.ok && two.error).toMatch(/names several dates.*2026-11-05.*2026-11-20/);
    expect(resolveTerm("либо 5 ноября, либо 20 ноября", AT, "2026-11-20")).toMatchObject({ ok: true, term: { day: "2026-11-20" } });
  });

  it("refuses a --due the text does not name, and says what the text names", () => {
    const wrong = resolveTerm("до 5 ноября", AT, "2026-12-01");
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.error).toMatch(/does not name 2026-12-01; it names 2026-11-05/);
    const none = resolveTerm("да, отложи это", AT, "2026-11-05");
    expect(!none.ok && none.error).toMatch(/names no date; leave --due out/);
    expect(resolveTerm("до 5 ноября", AT, "завтра")).toMatchObject({ ok: false });
  });

  it("a decision without a date gets 14 days from the message and says so (due_source default_14d)", () => {
    expect(resolveTerm("да, отложи", AT)).toMatchObject({ ok: true, term: { day: "2026-11-05", source: "default_14d", match: null } });
  });

  it("reads --due as a day", () => {
    expect(dayOfArg("2026-11-05")).toBe("2026-11-05");
    expect(dayOfArg("2026-11-05T10:00:00Z")).toBe("2026-11-05");
    expect(dayOfArg("5 ноября")).toBeNull();
    expect(dayOfArg("2026-02-30")).toBeNull();
  });
});
