import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { timeRpcHandlers } from "../src/server/rpc-timing";
import { logIncidents } from "../src/rooms/self-repair/server/self-repair";
import type { LanePilotDatabase } from "../src/database";

describe("RPC duration logging", () => {
  it("logs every call with its duration, adds the answer size to a slow one and leaves answers and errors alone", async () => {
    const lines: string[] = [];
    let clock = 0;
    const handlers = timeRpcHandlers({
      quick: async () => { clock += 12; return { ok: true }; },
      slow: async () => { clock += 4_510; return { blob: "x".repeat(2_500_000) }; },
      broken: async () => { clock += 30; throw new Error("boom"); },
    }, (line) => lines.push(line), () => clock);
    expect(await handlers.quick()).toEqual({ ok: true });
    expect((await handlers.slow() as { blob: string }).blob).toHaveLength(2_500_000);
    await expect(handlers.broken()).rejects.toThrow("boom");
    expect(lines).toEqual(["rpc quick 12 ms", "rpc slow 4510 ms 2.5 MB", "rpc broken 30 ms failed"]);
  });
  it("is wired into the plugin: a registered RPC leaves a debug line in the plugin log", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    await harness.behavior.callRpc("get_preferences", { suggestedLocale: "en" });
    const entry = harness.logEntries.find((row) => row.level === "debug" && /^rpc get_preferences \d+ ms$/.test(row.message));
    expect(entry).toBeTruthy();
    await harness.lifecycle.dispose();
  });
});
