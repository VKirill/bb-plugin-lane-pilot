import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createOwnerGate, guardRpc } from "../src/server/owner-gate";
import { timeRpcHandlers } from "../src/server/rpc-timing";
import { logIncidents } from "../src/server/self-repair";
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

  it("logs a call the owner gate kept out as refused, which the self-repair watcher does not take for a fault", async () => {
    // The hub on 2026-10-08 12:16:10 (and save_setting at 12:07:51): an audit thread curled reset_project_settings with no
    // caller marks, the gate refused it as designed, the log said `rpc reset_project_settings 1 ms failed`, and the watcher
    // opened a repair thread for it.
    const lines: string[] = [];
    const gate = createOwnerGate({ db: {} as LanePilotDatabase, ownerAsk: undefined, log: (line) => lines.push(line) });
    const handlers = timeRpcHandlers(guardRpc({
      reset_project_settings: async () => ({ ok: true }),
      halt_run: async () => { throw new Error("run not found"); },
    }, gate), (line) => lines.push(line), () => 0);
    const anonymous = { experimental_vkCaller: { kind: "unknown", evidence: "none" } };
    const input = { projectId: "__audit__", keys: ["__audit__"], expectedVersions: { __audit__: 0 } };
    await expect((handlers.reset_project_settings as (input: unknown, ctx: unknown) => Promise<unknown>)(input, anonymous)).rejects.toThrow(/^Refused: reset_project_settings/);
    await expect((handlers.halt_run as (input: unknown, ctx: unknown) => Promise<unknown>)({}, { experimental_vkCaller: { kind: "owner-ui" } })).rejects.toThrow("run not found");
    expect(lines).toEqual(["Lane Pilot: reset_project_settings refused for a unknown caller", "rpc reset_project_settings 0 ms refused", "rpc halt_run 0 ms failed"]);

    const log = (messages: string[]) => messages.map((message, index) => JSON.stringify({ ts: 1791461770623 + index, level: "debug", message })).join("\n");
    expect(logIncidents(log(lines.slice(0, 2)), 0)).toEqual([]);
    // A real failure of a handler is still an incident.
    expect(logIncidents(log(lines.slice(2)), 0).map((row) => row.reason)).toEqual(["rpc halt_run 0 ms failed"]);
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
