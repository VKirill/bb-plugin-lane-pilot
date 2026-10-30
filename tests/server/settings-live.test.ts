import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { loadProjectSettings, openDatabase, saveProjectSetting } from "../../src/rooms/storage";

/**
 * The restart-only list is gone (owner's rule: no UI setting needs a plugin reload): every one of the old three is read at
 * use time — `jev.provider` inside jevEndpoint on each call, `workspace.provider` inside the spawn's providerSkipReason on
 * each attempt, `sandbox.backend` inside the verification call — so a saved value applies to the very next use.
 */
describe("settings are live, not restart-only", () => {
  it("a saved jev.provider / workspace.provider / sandbox.backend is what the next read sees, for each consumer's own read path", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    // The global read of the Jev endpoint.
    expect(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID)["jev.provider"]).toBeUndefined();
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "jev.provider", "typesafe");
    expect(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID)["jev.provider"]).toBe("typesafe");
    // The project read the spawn's provider gate makes.
    saveProjectSetting(db, "proj-1", "workspace.provider", "off");
    expect(loadProjectSettings(db, "proj-1")["workspace.provider"]).toBe("off");
    // The project read the verification call makes.
    saveProjectSetting(db, "proj-1", "sandbox.backend", "macos-seatbelt");
    expect(loadProjectSettings(db, "proj-1")["sandbox.backend"]).toBe("macos-seatbelt");
    expect(loadProjectSettings(db, "proj-1")["workspace.provider"]).toBe("off");
  });
});
