import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

describe("settings CAS over RPC", () => {
  it("rejects a stale version and keeps the stored value", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const first = await harness.behavior.callRpc("save_setting", {
      projectId: "proj_a",
      key: "ui.language",
      value: "en",
      expectedVersion: 0,
    }) as { ok: boolean; version: number };
    expect(first.ok).toBe(true);
    const conflict = await harness.behavior.callRpc("save_setting", {
      projectId: "proj_a",
      key: "ui.language",
      value: "ru",
      expectedVersion: 0,
    }) as { ok: boolean; conflict: boolean; value: unknown };
    expect(conflict.ok).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(conflict.value).toBe("en");
    const isolated = await harness.behavior.callRpc("get_screen", { projectId: "proj_b" }) as {
      values: Record<string, unknown>;
    };
    expect(isolated.values["ui.language"]).toBeUndefined();
    await harness.lifecycle.dispose();
  });
});
