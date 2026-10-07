import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server";
import { DRAIN_SNAPSHOT_KEY, skipRedundantStartupScans } from "../src/server/deploy-drain";
import { PARKED_KEY } from "../src/server/stability";

const host = () => createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { list: async () => [] } }, hostCall: async () => ({}) } as never);

it("startup recovery reads the VK start reason in its service and consumes the drain snapshot", async () => {
  const { bb, harness } = host();
  await bb.storage.kv.set(DRAIN_SNAPSHOT_KEY, { action: "reload", at: 1, clean: true, inFlight: [] });
  const info = vi.spyOn(bb.log, "info");
  (bb as unknown as { vk: unknown }).vk = { startReason: "reload", afterDrain: true };
  await plugin(bb);
  harness.runService("startup-recovery");
  await vi.waitFor(async () => expect(await bb.storage.kv.get(DRAIN_SNAPSHOT_KEY)).toBeUndefined());
  const lines = info.mock.calls.map((call) => String(call[0])).join("\n");
  expect(lines).toContain("startup recovery: reload, after a clean drain");
  expect(lines).toContain("nothing in flight");
  await harness.lifecycle.dispose();
});

it("without bb.vk the recovery runs as before and leaves kv alone", async () => {
  const { bb, harness } = host();
  await bb.storage.kv.set(DRAIN_SNAPSHOT_KEY, { action: "reload", at: 1, clean: true, inFlight: [] });
  await plugin(bb);
  harness.runService("startup-recovery");
  await new Promise((wake) => setTimeout(wake, 100));
  expect(await bb.storage.kv.get(DRAIN_SNAPSHOT_KEY)).toBeDefined();
  await harness.lifecycle.dispose();
});

async function startAfter(vk: { startReason: string; afterDrain: boolean }, snapshot: unknown) {
  const { bb, harness } = host();
  if (snapshot) await bb.storage.kv.set(DRAIN_SNAPSHOT_KEY, snapshot as never);
  const info = vi.spyOn(bb.log, "info");
  const parkedReads = vi.spyOn(bb.storage.kv, "get");
  (bb as unknown as { vk: unknown }).vk = vk;
  await plugin(bb);
  harness.runService("startup-recovery");
  await vi.waitFor(() => expect(info.mock.calls.map((call) => String(call[0])).join("\n")).toContain("startup recovery: "));
  // The last step of the recovery is the browser check recovery; its adoption has no log, so wait on the kv reads.
  await new Promise((wake) => setTimeout(wake, 300));
  const lines = info.mock.calls.map((call) => String(call[0])).join("\n");
  const parked = parkedReads.mock.calls.filter((call) => call[0] === PARKED_KEY).length;
  await harness.lifecycle.dispose();
  return { lines, parked };
}

it("skips the run, worktree and parked-task scans after a clean reload drain, and only then", async () => {
  const clean = { action: "reload", at: 1, clean: true, inFlight: [] };
  const skipped = await startAfter({ startReason: "reload", afterDrain: true }, clean);
  expect(skipped.lines).toContain("scans left to their schedules after a clean drain");
  // Only the parking of blocked tasks reads the parked list; the sweep that would read it again is skipped.
  const skippedReads = skipped.parked;
  for (const [vk, snapshot] of [
    [{ startReason: "reload", afterDrain: true }, { action: "reload", at: 1, clean: false, inFlight: [{ method: "gitIntegrate", ageSec: 1 }] }],
    [{ startReason: "reload", afterDrain: false }, clean],
    [{ startReason: "boot", afterDrain: false }, clean],
    [{ startReason: "reload", afterDrain: true }, undefined],
  ] as const) {
    const ran = await startAfter(vk, snapshot);
    expect(ran.lines, JSON.stringify([vk, snapshot])).not.toContain("left to their schedules");
    // The parked-task sweep is part of the ordered task reconcile now and runs on every start (a lost retry is restarted
    // in the same start-up), so only the run and worktree scans depend on a clean drain.
    expect(ran.parked, JSON.stringify([vk, snapshot])).toBeGreaterThanOrEqual(skippedReads);
  }
});

it("skipRedundantStartupScans needs a reload, a finished drain and a clean snapshot of a reload", () => {
  const clean = { action: "reload", clean: true };
  expect(skipRedundantStartupScans({ startReason: "reload", afterDrain: true }, clean)).toBe(true);
  expect(skipRedundantStartupScans({ startReason: "reload", afterDrain: false }, clean)).toBe(false);
  expect(skipRedundantStartupScans({ startReason: "enable", afterDrain: true }, clean)).toBe(false);
  expect(skipRedundantStartupScans({ startReason: "reload", afterDrain: true }, { action: "shutdown", clean: true })).toBe(false);
  expect(skipRedundantStartupScans({ startReason: "reload", afterDrain: true }, { action: "reload", clean: false })).toBe(false);
  expect(skipRedundantStartupScans({ startReason: "reload", afterDrain: true }, undefined)).toBe(false);
  expect(skipRedundantStartupScans({}, clean)).toBe(false);
});
