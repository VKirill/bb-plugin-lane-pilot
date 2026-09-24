import { describe, expect, it } from "vitest";
import {
  decideHelperDispatch,
  helperContextToPolicy,
  intersectPolicy,
  parseHelperContextSettings,
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
});
