import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server";
import { DRAIN_SNAPSHOT_KEY } from "../src/rooms/stability/server";
import { PARKED_KEY } from "../src/rooms/contracts/stability-api";

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

it("runs the run, worktree and parked-task scans on every start, a clean reload drain included: no schedule picks them up later", async () => {
  const clean = { action: "reload", at: 1, clean: true, inFlight: [] };
  const afterCleanDrain = await startAfter({ startReason: "reload", afterDrain: true }, clean);
  expect(afterCleanDrain.lines).not.toContain("skipped after a clean drain");
  expect(afterCleanDrain.lines).not.toContain("left to their schedules");
  for (const [vk, snapshot] of [
    [{ startReason: "reload", afterDrain: true }, { action: "reload", at: 1, clean: false, inFlight: [{ method: "gitIntegrate", ageSec: 1 }] }],
    [{ startReason: "boot", afterDrain: false }, clean],
  ] as const) {
    const ran = await startAfter(vk, snapshot);
    expect(afterCleanDrain.parked, JSON.stringify([vk, snapshot])).toBe(ran.parked);
  }
});
