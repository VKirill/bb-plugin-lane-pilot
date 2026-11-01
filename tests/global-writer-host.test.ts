import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

// 2026-10-30: global settings checked the writer model against the first connected machine; on the MacBook the devin
// provider lists one model, so SWE-2 could not be chosen as the global writer although the writer hosts list it. Since 0.1.445 a
// global pick is judged against every connected machine merged: the laptop below offers more models in all, yet SWE-2 is accepted.
describe("global writer selection", () => {
  it("accepts a model any connected machine offers, whichever machine the pickers show", async () => {
    const catalogs: Record<string, string[]> = { "host-laptop": ["adaptive", "a", "b", "c", "d"], "host-server": ["adaptive", "swe-2-high"] };
    const asked: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        hosts: { list: async () => [{ id: "host-laptop", name: "Laptop", status: "connected" }, { id: "host-server", name: "Server", status: "connected" }] },
        providers: {
          list: async () => [{ id: "devin", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }] as never,
          models: async ({ hostId }: { hostId?: string }) => {
            asked.push(hostId ?? "");
            return { models: (catalogs[hostId ?? ""] ?? []).map((id) => ({ id, model: id, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }] })) } as never;
          },
        },
      } as never,
    });
    await plugin(bb);
    const input = {
      projectId: "*", providerId: "devin", model: "swe-2-high", reasoningLevel: "high", serviceTier: null,
      expectedVersions: { "writer.provider": 0, "writer.model": 0, "writer.reasoning_effort": 0, "writer.service_tier": 0 },
    };
    const unnamed = await harness.behavior.callRpc("save_writer_selection", input) as { ok: boolean; validation?: { code: string } };
    expect(unnamed.ok).toBe(true);
    const named = await harness.behavior.callRpc("save_writer_selection", { ...input, expectedVersions: { "writer.provider": 1, "writer.model": 1, "writer.reasoning_effort": 1, "writer.service_tier": 1 }, selectedBinding: { hostId: "host-server", path: "/srv" } }) as { ok: boolean; values: Record<string, unknown> };
    expect(named.ok).toBe(true);
    expect(named.values).toMatchObject({ "writer.provider": "devin", "writer.model": "swe-2-high", "writer.reasoning_effort": "high" });
    expect(new Set(asked)).toEqual(new Set(["host-laptop", "host-server"]));
    await harness.lifecycle.dispose();
  });
});
