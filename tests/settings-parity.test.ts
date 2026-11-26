import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/plugin-db";
import { casUpsertSettings, loadProjectSettings } from "../src/rooms/storage";
import { validateSettingValue } from "../src/rooms/settings/models/setting-validation";
import { featureRegistry, featureRegistryGaps } from "../src/rooms/native-install";
import { bundledAgents } from "../src/rooms/contracts";

describe("settings and capability registry parity", () => {
  it("a setting is read back as saved and written only when the value passes: an out-of-range or stale write is refused and the stored value stays; an unset key reads nothing", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const key = "code_critique.max_rounds";
    expect(loadProjectSettings(db, "p")[key]).toBeUndefined();
    for (const [value, problem] of [[0, "integer 1-3"], [4, "integer 1-3"], ["x", "integer 1-3"], [1.5, "integer 1-3"]] as const) {
      expect(validateSettingValue(key, value), String(value)).toEqual({ code: "invalid_choice", key, params: [key, problem] });
    }
    for (const value of [1, 2, 3, "2"]) expect(validateSettingValue(key, value), String(value)).toBeNull();
    const refused = casUpsertSettings(db, { projectId: "p", changes: [{ key, value: 4, expectedVersion: 0 }] });
    expect(refused).toMatchObject({ ok: false, validation: { code: "invalid_choice" } });
    expect(loadProjectSettings(db, "p")[key]).toBeUndefined();
    expect(casUpsertSettings(db, { projectId: "p", changes: [{ key, value: 2, expectedVersion: 0 }] }).ok).toBe(true);
    expect(loadProjectSettings(db, "p")[key]).toBe(2);
    expect(casUpsertSettings(db, { projectId: "p", changes: [{ key, value: 3, expectedVersion: 0 }] })).toMatchObject({ ok: false, conflict: true });
    expect(loadProjectSettings(db, "p")[key]).toBe(2);
  });

  it("the registry lists one feature per bundled agent with its own agent and skills for each runtime, plus the session guard with its hook streams; every name in it is shipped", () => {
    const registry = featureRegistry();
    const agents = bundledAgents as Record<string, { skills?: string[] }>;
    expect(registry.map((feature) => feature.id)).toEqual([...Object.keys(agents), "session-guard"]);
    for (const [id, agent] of Object.entries(agents)) {
      const feature = registry.find((entry) => entry.id === id)!;
      expect(feature.agents, id).toEqual({ claude: [id], opencode: [id] });
      expect(feature.skills, id).toEqual({ claude: agent.skills ?? [], opencode: agent.skills ?? [] });
      expect(feature.hooks, id).toEqual({});
    }
    const guard = registry.find((feature) => feature.id === "session-guard")!;
    expect(guard.agents).toEqual({});
    expect(guard.hooks.claude?.length).toBeGreaterThan(0);
    expect(guard.hooks.opencode?.length).toBeGreaterThan(0);
    expect(featureRegistryGaps(registry)).toEqual([]);
    expect(featureRegistryGaps([...registry, { id: "made-up", agents: { claude: ["no-such-agent"] }, skills: { opencode: ["no-such-skill"] }, hooks: { claude: ["no-such-hook"] } }]))
      .toEqual(["made-up: unknown agent no-such-agent", "made-up: unknown hook no-such-hook", "made-up: unknown skill no-such-skill"]);
  });
});
