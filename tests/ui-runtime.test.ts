import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { SETTING_CATALOG } from "../src/channels";
import { UI_CATALOG } from "../src/ui-catalog";
import plugin from "../server";

describe("UI storage keys feed runtime channels", () => {
  it("intersects SETTING_CATALOG with generated storageKey values", () => {
    const stored = new Set(UI_CATALOG.map((row) => row.storageKey));
    const catalog = SETTING_CATALOG.map((spec) => spec.key);
    expect(catalog.filter((key) => stored.has(key))).toEqual(catalog);
  });

  it("saves writer.provider and jev keys that get_screen returns", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const provider = await harness.behavior.callRpc("save_setting", {
      projectId: "proj_runtime",
      key: "writer.provider",
      value: "opencode",
      expectedVersion: 0,
    }) as { ok: boolean };
    expect(provider.ok).toBe(true);
    const jev = await harness.behavior.callRpc("save_setting", {
      projectId: "proj_runtime",
      key: "jev.LANE_JEV_EFFORT",
      value: "0",
      expectedVersion: 0,
    }) as { ok: boolean };
    expect(jev.ok).toBe(true);
    const screen = await harness.behavior.callRpc("get_screen", { projectId: "proj_runtime" }) as {
      values: Record<string, unknown>;
      writerResultJson: string | null;
      lastReceiptJson: string | null;
    };
    expect(screen.values["writer.provider"]).toBe("opencode");
    expect(screen.values["jev.LANE_JEV_EFFORT"]).toBe("0");
    expect(screen.writerResultJson).toBeNull();
    expect(screen.lastReceiptJson).toBeNull();
    await harness.lifecycle.dispose();
  });
});
