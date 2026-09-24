import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { openDatabase, savePrototypeConfig } from "../src/database";

describe("project source catalog", () => {
  it("does not save writer selection when projects.get fails", async () => {
    const projectId = "proj_catalog_fail";
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        providers: {
          list: async () => [{ id: "claude-code", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }] as never,
          models: async () => ({ models: [{ id: "claude-opus-5", model: "claude-opus-5", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }] }] as never }),
        },
        projects: {
          get: async () => {
            throw new Error("permission denied");
          },
        },
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId, hostId: "host-stale", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer",
      pmProviderId: "claude-code", pmModel: "claude-opus-5", writerProviderId: "codex", writerModel: "gpt-test",
    });
    await plugin(bb);
    const screen = await harness.behavior.callRpc("get_screen", { projectId }) as {
      hostId: string | null;
      writerBinding?: { status: string; hostId: string | null };
    };
    expect(screen.writerBinding?.status).toBe("catalog_unavailable");
    expect(screen.hostId).toBeNull();
    const saved = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "medium", serviceTier: null,
      expectedVersions: { "writer.provider": 0, "writer.model": 0, "writer.reasoning_effort": 0, "writer.service_tier": 0 },
    }) as { ok: boolean; validation?: { code: string } };
    expect(saved).toMatchObject({ ok: false, validation: { code: "catalog_unavailable" } });
    await harness.lifecycle.dispose();
  });
});
