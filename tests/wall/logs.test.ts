import { describe, expect, it } from "vitest";
import { collectEntries, refreshClasses, writeEntries } from "../../src/rooms/wall/journal";
import { wallLogLines } from "../../src/rooms/wall/logs";
import { logOrigin, logSignature } from "../../src/rooms/wall/signature";
import { selectClasses } from "../../src/rooms/wall/select";
import type { WallClass } from "../../src/rooms/wall/types";
import { DAY, HOUR, NOW, freshDb, isReal } from "./helpers";

describe("the plugin log as a source of the journal", () => {
  const line = (level: string, message: string, ts = NOW - HOUR) => JSON.stringify({ ts, level, message });
  const log = [
    line("warn", "relay: could not tell thr_abc123 its task results: HTTP 409: Thread is archived"),
    line("warn", "relay: fired 1, settled 0"),
    line("warn", "relay: told thr_abc123 2 task result(s)"),
    line("warn", "integration-gate: running `npm test` on /repo"),
    line("warn", "Lane Pilot nightly docs failed for /repo: Host is not connected"),
    line("error", "something odd happened in proj_abc"),
    line("info", "Lane Pilot closed 2 runs"),
    line("warn", "self-repair tick failed: x"),
    line("warn", "writer v1-check waits: only 9 GB free on host_1"),
    line("warn", "old failure", NOW - 3 * DAY),
    "not json",
  ].join("\n");

  it("keeps errors and warnings that say they failed, not the ordinary status the plugin logs at warn level", () => {
    const lines = wallLogLines(log, NOW - DAY, NOW);
    expect(lines.map((row) => row.message)).toEqual([
      "relay: could not tell thr_abc123 its task results: HTTP 409: Thread is archived",
      "Lane Pilot nightly docs failed for /repo: Host is not connected",
      "something odd happened in proj_abc",
      "writer v1-check waits: only 9 GB free on host_1",
    ]);
    expect(lines[2]!.projectId).toBe("proj_abc");
  });

  it("the same message shape with other ids is one class; a disconnected machine is infra", () => {
    expect(logSignature("relay: could not tell thr_aaa its task results: HTTP 409: Thread is archived").classKey)
      .toBe(logSignature("relay: could not tell thr_bbb its task results: HTTP 409: Thread is archived").classKey);
    expect(logOrigin("docs failed: Host is not connected")).toBe("infra");
    expect(logOrigin("relay: could not tell")).toBe("harness");
  });

  it("enters the journal with the version running at the time; a log class is open on two nights and three lines", () => {
    const { db, attempt } = freshDb();
    attempt("accepted", null, NOW - 20 * HOUR, { version: "0.1.267" });
    attempt("accepted", null, NOW - 10 * HOUR, { version: "0.1.268" });
    const storm = (at: number) => ({ message: "relay: could not tell thr_aaa its task results: HTTP 409: Thread is archived", at, projectId: "-" });
    const first = collectEntries(db, { since: NOW - DAY, until: NOW, isReal, logLines: [storm(NOW - 15 * HOUR), storm(NOW - 5 * HOUR), storm(NOW - 4 * HOUR)], now: NOW });
    expect(first.map((row) => [row.version, row.n, row.origin]).sort()).toEqual([["0.1.267", 1, "harness"], ["0.1.268", 2, "harness"]]);
    writeEntries(db, first, NOW);
    expect(refreshClasses(db, { now: NOW, isReal }).find((row) => row.failureClass === "log")).toMatchObject({ state: "closed", recur1: 3 });   // one night: not yet a pattern
    const next = NOW + DAY;
    writeEntries(db, collectEntries(db, { since: NOW, until: next, isReal, logLines: [storm(NOW + 2 * HOUR)], now: next }), next);
    expect(refreshClasses(db, { now: next, isReal }).find((row) => row.failureClass === "log")).toMatchObject({ state: "open", recur7: 4, recur1: 1 });
  });
});

describe("a class seen only under older versions waits for the release that may have fixed it", () => {
  const cls = { classKey: "harness:a", failureClass: "harness", reasonNorm: "r", origin: "harness", firstSeen: 0, lastSeen: 0, total: 9, counts: [9, 9, 9], windows: [10, 10, 10], rung: 0, state: "open",
    recur7: 9, recur1: 9, failedMoves: 0, hunt: "none", afterHuntFailed: 0, stage: "moves" } as unknown as WallClass;
  const base = { classes: [cls], max: 3, walks: 2, recurrenceFloor: 3, openRepair: new Set<string>(), roundsTonight: new Map<string, number>(), roundsPerNight: 2, tokensLeft: 9e9, roundCost: 1 };

  it("skips it with the reason; a failure under the running version, or of unknown version, qualifies", () => {
    const old = selectClasses({ ...base, runningVersion: "0.1.268", seenVersions: new Map([["harness:a", new Set(["0.1.256", "0.1.267"])]]) });
    expect(old.picked).toEqual([]);
    expect(old.morning[0]!.why).toMatch(/seen only under 0\.1\.267, 0\.1\.268 runs now/);
    expect(selectClasses({ ...base, runningVersion: "0.1.268", seenVersions: new Map([["harness:a", new Set(["0.1.267", "0.1.268"])]]) }).picked).toHaveLength(1);
    expect(selectClasses({ ...base, runningVersion: "0.1.268", seenVersions: new Map([["harness:a", new Set([""])]]) }).picked).toHaveLength(1);
    expect(selectClasses({ ...base }).picked).toHaveLength(1);
  });
});
