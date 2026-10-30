import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

// 2026-10-30: global settings checked the writer model against the first connected machine; on the MacBook the devin
// provider lists one model, so SWE-2 could not be chosen as the global writer although the writer hosts list it.
describe("global writer selection", () => {
  it("checks the model on the machine the caller names, not on the first connected one", async () => {
    const catalogs: Record<string, string[]> = { "host-laptop": ["adaptive"], "host-server": ["adaptive", "swe-2-high"] };
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
    expect(unnamed).toMatchObject({ ok: false, validation: { code: "invalid_choice" } });
    const named = await harness.behavior.callRpc("save_writer_selection", { ...input, selectedBinding: { hostId: "host-server", path: "/srv" } }) as { ok: boolean; values: Record<string, unknown> };
    expect(named.ok).toBe(true);
    expect(named.values).toMatchObject({ "writer.provider": "devin", "writer.model": "swe-2-high", "writer.reasoning_effort": "high" });
    expect(asked).toEqual(["host-laptop", "host-server"]);
    await harness.lifecycle.dispose();
  });
});
