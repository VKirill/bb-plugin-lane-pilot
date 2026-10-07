import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server";
import { DRAIN_SNAPSHOT_KEY } from "../src/server/deploy-drain";

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
