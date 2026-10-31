import { describe, expect, it } from "vitest";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { createWriterHost } from "../src/rooms/writer/server";

// 2026-10-31: the global role table asked the first connected machine (the MacBook) for models; it had no OpenCode and Devin
// listed only «Agent default», so SWE-2 could not be picked.
const catalog: Record<string, Record<string, string[]>> = {
  host_macbook: { devin: ["acp-default"] },
  host_mini: { devin: ["swe-2-high", "adaptive"], opencode: ["glm-5-2"] },
};
const ctx = {
  log: () => undefined,
  bb: {
    storage: { kv: { get: async () => null } },
    sdk: {
      hosts: { list: async () => [{ id: "host_macbook", name: "MacBook", status: "connected" }, { id: "host_mini", name: "MAC Mini", status: "connected" }] },
      providers: {
        list: async ({ hostId }: { hostId: string }) => Object.keys(catalog[hostId] ?? {}).map((id) => ({ id, displayName: id, available: true })),
        models: async ({ hostId, providerId }: { hostId: string; providerId: string }) => ({
          models: (catalog[hostId]?.[providerId] ?? []).map((id) => ({ id, model: id, displayName: id, supportedReasoningEfforts: [] })),
        }),
      },
    },
  },
};

describe("global settings host", () => {
  it("routes the pickers to the machine offering the most providers and models", async () => {
    const host = createWriterHost(ctx as never);
    expect(await host.resolveProjectWriterHost({ projectId: GLOBAL_SETTINGS_PROJECT_ID })).toMatchObject({ status: "resolved", hostId: "host_mini" });
  });

  it("keeps a machine the caller named", async () => {
    const host = createWriterHost(ctx as never);
    expect(await host.resolveProjectWriterHost({ projectId: GLOBAL_SETTINGS_PROJECT_ID, selected: { hostId: "host_macbook", path: "" } }))
      .toMatchObject({ hostId: "host_macbook" });
  });
});
