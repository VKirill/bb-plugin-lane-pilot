import { describe, expect, it } from "vitest";
import {
  CORE_PROVIDER_GROUPS,
  MANDATORY_BB_PLUGINS,
  MANDATORY_MCP_SERVERS,
  coreRequiredSessionAdvertisement,
  decideHelperDispatch,
  detectRequiredSessionPolicyCapability,
  detectVkCapability,
  helperContextToPolicy,
  intersectPolicy,
  parseHelperContextSettings,
  requiredSessionPolicySpawnBinding,
} from "../src/helper-context";

describe("helper session filter", () => {
  it("treats missing mode as inherit and does not emit a child policy", () => {
    const parsed = parseHelperContextSettings({});
    expect(parsed).toEqual({ ok: true, settings: { mode: "inherit", skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] } });
    if (!parsed.ok) return;
    expect(helperContextToPolicy(parsed.settings)).toBeNull();
    expect(decideHelperDispatch({ settings: parsed.settings, capability: "none" })).toMatchObject({
      ok: true, enforcement: "inherit-parent", required: false, residualFailOpen: false, policy: null,
    });
  });

  it("rejects an invalid stored mode instead of mapping it to inherit", () => {
    expect(parseHelperContextSettings({ "helper.context_mode": "strict" })).toEqual({
      ok: false, reason: "helper_context_mode_invalid",
    });
  });

  it("treats an empty selected list as none of that kind, not inherit", () => {
    const parsed = parseHelperContextSettings({ "helper.context_mode": "selected", "helper.skills": "  " });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.skills).toEqual([]);
    expect(helperContextToPolicy(parsed.settings)?.skills).toEqual({ mode: "allow", names: [] });
  });

  it("refuses selected/none on dynamic or missing APIs", () => {
    const parsed = parseHelperContextSettings({ "helper.context_mode": "none" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(decideHelperDispatch({ settings: parsed.settings, capability: "none" })).toEqual({
      ok: false, reason: "helper_context_required_api_unavailable",
    });
    expect(decideHelperDispatch({ settings: parsed.settings, capability: "dynamic" })).toEqual({
      ok: false, reason: "helper_context_required_api_unavailable",
    });
  });

  it("keeps a required parent ceiling on inherit and refuses when that ceiling cannot be enforced", () => {
    const parsed = parseHelperContextSettings({ "helper.context_mode": "inherit" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const parent = { skills: { mode: "allow" as const, names: ["lane-contract"] }, required: true };
    expect(decideHelperDispatch({ settings: parsed.settings, capability: "dynamic", parentPolicy: parent, parentRequired: true })).toEqual({
      ok: false, reason: "helper_context_parent_ceiling_unenforced",
    });
    const allowed = decideHelperDispatch({ settings: parsed.settings, capability: "required", parentPolicy: parent, parentRequired: true });
    expect(allowed).toMatchObject({ ok: true, required: true, policy: { skills: parent.skills, required: true } });
  });

  it("intersects selected lists with the parent allow-list and does not widen", () => {
    const parent = { skills: { mode: "allow" as const, names: ["a", "b"] }, required: true };
    const child = helperContextToPolicy({
      mode: "selected", skills: ["b", "c"], mcpServers: [], bbPlugins: [], nativePlugins: [],
    });
    expect(intersectPolicy(parent, child)?.skills).toEqual({ mode: "allow", names: ["b"] });
  });

  it("reuses a durable snapshot instead of live settings that would widen", () => {
    const snapshot = {
      schemaVersion: 1 as const,
      mode: "inherit" as const,
      settings: { mode: "inherit" as const, skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] },
      parentRequired: false,
      parentPolicy: null,
      policy: null,
    };
    const live = parseHelperContextSettings({ "helper.context_mode": "selected", "helper.skills": "new-skill" });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    const decision = decideHelperDispatch({ settings: live.settings, capability: "none", snapshot });
    expect(decision).toMatchObject({ ok: true, snapshot: { mode: "inherit" } });
  });

  it("gates required spawn on the static capability object and never puts the snapshot in metadata shape", () => {
    expect(detectRequiredSessionPolicyCapability({
      experimental_vkRequiredSessionPolicy: () => ({ persist: true }),
    })).toBe(false);
    expect(detectVkCapability({
      experimental_vkRequiredSessionPolicy: () => ({ persist: true }),
      experimental_vkSessionPolicy: () => ({}),
    })).toBe("dynamic");
    expect(detectVkCapability({
      experimental_vkRequiredSessionPolicy: () => ({
        version: 1, persist: true, requiredMarker: true, snapshotDigest: true, parentCeiling: true,
      }),
    })).toBe("none");
    const advertised = coreRequiredSessionAdvertisement();
    expect(detectVkCapability({
      experimental_vkRequiredSessionPolicy: () => advertised,
    })).toBe("required");
    const inherit = {
      schemaVersion: 1 as const,
      mode: "inherit" as const,
      settings: { mode: "inherit" as const, skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] },
      parentRequired: false,
      parentPolicy: null,
      policy: null,
    };
    expect(requiredSessionPolicySpawnBinding({ capability: "none", snapshot: inherit })).toEqual({});
    const selected = decideHelperDispatch({
      settings: { mode: "selected", skills: ["lane-contract"], mcpServers: [], bbPlugins: [], nativePlugins: [] },
      capability: "required",
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(() => requiredSessionPolicySpawnBinding({ capability: "dynamic", snapshot: selected.snapshot }))
      .toThrow(/helper_context_required_api_unavailable/);
    const field = requiredSessionPolicySpawnBinding({
      capability: "required",
      snapshot: selected.snapshot,
      advertised,
      providerId: "claude-code",
    });
    expect(field.experimental_vkRequiredSessionPolicy).toEqual({
      version: 1,
      policy: {
        skills: { mode: "allow", names: ["lane-contract"] },
        mcpServers: { mode: "allow", names: [...MANDATORY_MCP_SERVERS] },
        bbPlugins: { mode: "allow", names: [...MANDATORY_BB_PLUGINS] },
        nativePlugins: { mode: "allow", names: [] },
      },
    });
    expect(field.experimental_vkRequiredSessionPolicy.policy).not.toHaveProperty("required");
    expect(JSON.stringify(field)).not.toMatch(/pluginMetadata/);
  });

  it("does not treat a five-flag advertisement without handshake/protocol as required", () => {
    expect(detectRequiredSessionPolicyCapability({
      experimental_vkRequiredSessionPolicy: () => ({
        version: 1, persist: true, requiredMarker: true, snapshotDigest: true, parentCeiling: true,
      }),
    })).toBe(false);
    const parsed = parseHelperContextSettings({ "helper.context_mode": "none" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(decideHelperDispatch({ settings: parsed.settings, capability: "none" })).toEqual({
      ok: false, reason: "helper_context_required_api_unavailable",
    });
  });

  it("refuses acp-cursor nativePlugins selected instead of dropping the field", () => {
    const advertised = coreRequiredSessionAdvertisement();
    const selected = decideHelperDispatch({
      settings: { mode: "selected", skills: [], mcpServers: [], bbPlugins: [], nativePlugins: ["cursor-extra"] },
      capability: "required",
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(CORE_PROVIDER_GROUPS["acp-cursor"]).not.toContain("nativePlugins");
    expect(() => requiredSessionPolicySpawnBinding({
      capability: "required",
      snapshot: selected.snapshot,
      advertised,
      providerId: "acp-cursor",
    })).toThrow(/helper_context_unsupported_provider_group:nativePlugins/);
  });

  it("keeps mandatory checkout plugins and bb-bridge on none", () => {
    const none = helperContextToPolicy({
      mode: "none", skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [],
    });
    expect(none?.bbPlugins).toEqual({ mode: "allow", names: [...MANDATORY_BB_PLUGINS] });
    expect(none?.mcpServers).toEqual({ mode: "allow", names: [...MANDATORY_MCP_SERVERS] });
  });
});
