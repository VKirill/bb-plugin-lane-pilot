import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { BEAT_KEY, gapOutage, listOutages } from "../../src/rooms/outage";
import { recordStartGap, runOutageCli } from "../../src/rooms/outage/server";
import { conveyorState, isHeld, setConveyor } from "../../src/rooms/runs/server";
import { setRunPaused } from "../../src/rooms/runs/server";
import { waitWhileRunPaused } from "../../src/rooms/runs/server";
import { openDatabase } from "../../src/rooms/storage/database";

const NOW = Date.parse("2026-10-23T10:00:00Z");

describe("outages", () => {
  it("a gap in the heartbeat over five minutes is an outage, a reload is not, and a first start is not", () => {
    expect(gapOutage(NOW - 4 * 60_000, NOW)).toBeNull();
    expect(gapOutage(null, NOW)).toBeNull();
    expect(gapOutage(NOW - 42 * 60_000, NOW)).toEqual({ fromAt: NOW - 42 * 60_000, toAt: NOW, minutes: 42 });
  });

  it("the start records the gap once and beats; the command lists the outages", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    await bb.storage.kv.set(BEAT_KEY, (NOW - 3_600_000) as never);
    const ctx = { bb, db, log: () => undefined, isDisposed: () => true };
    expect(await recordStartGap(ctx as never, NOW)).toMatchObject({ minutes: 60 });
    expect(listOutages(db, 0)).toEqual([expect.objectContaining({ minutes: 60, fromAt: NOW - 3_600_000, toAt: NOW })]);
    expect(await bb.storage.kv.get(BEAT_KEY)).toBe(NOW);
    expect(await recordStartGap(ctx as never, NOW + 60_000)).toBeNull();
    expect(listOutages(db, 0)).toHaveLength(1);
    expect(JSON.parse(runOutageCli(ctx as never, ["--days", "1"], NOW).stdout!)).toHaveLength(1);
    expect(runOutageCli(ctx as never, ["--days", "x"], NOW).exitCode).toBe(1);
  });
});

describe("the conveyor switch", () => {
  it("off holds every run like a pause, keeps the reason, and on lets them go; a run's own pause is untouched", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const kv = bb.storage.kv as never;
    expect(await conveyorState(kv)).toEqual({ on: true, since: null, reason: null });
    expect(await isHeld(kv, "run1")).toBe(false);
    const off = await setConveyor(kv, false, "hub maintenance");
    expect(off).toMatchObject({ on: false, reason: "hub maintenance" });
    expect(await isHeld(kv, "run1")).toBe(true);
    let released = false;
    const waiting = waitWhileRunPaused(kv, "run1", { isDisposed: () => false, pollMs: 5 }).then((value) => { released = value; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(released).toBe(false);
    await setConveyor(kv, true);
    await waiting;
    expect(released).toBe(true);
    await setRunPaused(kv, "run2", true);
    expect(await isHeld(kv, "run2")).toBe(true);
    expect(await isHeld(kv, "run1")).toBe(false);
  });
});
