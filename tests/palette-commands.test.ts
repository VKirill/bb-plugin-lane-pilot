import { describe, expect, it } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

describe("command palette (B-x3)", () => {
  it("lists the helpers tab command only on a thread and opens that tab", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const actions = (app as unknown as { commandPaletteActions: Array<{ id: string; isAvailable?: (c: unknown) => boolean; run: (c: unknown) => unknown }> }).commandPaletteActions;
    const command = actions.find((action) => action.id === "lane-pilot-helpers");
    expect(command).toBeTruthy();
    expect(command!.isAvailable?.({ threadId: null, projectId: null, experimental_panel: {} } as never)).toBe(false);
    const opened: unknown[] = [];
    const panel = { openTab: (options: unknown) => { opened.push(options); return true; } };
    expect(command!.isAvailable?.({ threadId: "thr_1", projectId: "proj_1", experimental_panel: panel } as never)).toBe(true);
    await command!.run({ threadId: "thr_1", projectId: "proj_1", experimental_panel: panel } as never);
    expect(opened).toHaveLength(1);
    expect((opened[0] as { tab: { id: string } }).tab.id).toBe("lane-helper-thread");
  });
});
