import { describe, expect, it } from "vitest";
import {
  ROLE_MODEL_OPTIONS, WRITER_PROFILES, consistentProvider, inZcodePromo, modelFamily, modelTier, nextZcodePromoStart, resolveAgentModel, resolveRoleModel, roleModelKey, roleModelOption,
  roleModelProblem, tableRowAt, writerCandidates, zcodeBlock, zcodeEnvironmentError, zcodeWindowMode, zcodeWindowProblem, type ModelCatalog,
} from "@lane-pilot/models";

const at = (hour: number, minute = 0) => Date.UTC(2026, 9, 27, hour, minute);
const catalogWith = (hostIds: string[]): ModelCatalog => ({
  hosts: [{ id: "mini", name: "Mac mini", connected: true }, { id: "ovh", name: "OVH", connected: true }],
  providers: [{ id: "zcode", displayName: "ZCode", logoUrl: null, family: "acp", supportsServiceTier: false, serviceTiers: [], hostIds,
    models: [{ id: "glm-5.3-flash", model: "glm-5.3-flash", displayName: "GLM-5.3-Flash", efforts: ["low", "high", "max"], defaultEffort: "high", isDefault: true, hostIds }] }],
});

describe("ZCode · GLM-5.3-Flash in the writers' anamnesis", () => {
  it("is a standard-tier writer candidate on the zcode provider with an honest description and sources, and is no role's default", () => {
    const profile = WRITER_PROFILES.find((row) => row.key === "zcode-flash")!;
    expect(profile).toMatchObject({ providerId: "zcode", model: "glm-5.3-flash", label: "ZCode · GLM-5.3-Flash", tier: "standard", available: true });
    expect(profile.sources.length).toBeGreaterThan(0);
    for (const word of ["large", "one task at a time", "Mac mini", "15:00 to 01:00 UTC", "tiny"]) expect(profile.summary.toLowerCase(), word).toContain(word.toLowerCase());
    expect(writerCandidates({}).map((row) => row.key)).toContain("zcode-flash");
    expect(writerCandidates({ "writer.models": ["composer"] }).map((row) => row.key)).not.toContain("zcode-flash");
  });
});

describe("ZCode in the table «role -> model»", () => {
  it("is an option of the GLM family on the zcode provider, never the default of a row, and not mistaken for the OpenCode GLM", () => {
    expect(ROLE_MODEL_OPTIONS.find((option) => option.id === "glm-5.3-flash")).toMatchObject({ providerId: "zcode", family: "glm", label: "ZCode · GLM-5.3-Flash", efforts: ["low", "high", "max"] });
    expect(modelTier("glm-5.3-flash")).toBe("light");
    expect(modelFamily("glm-5.3-flash")).toBe("glm");
    expect(modelFamily("zai-coding-plan/glm-5.3-flash")).toBe("glm");
    // The OpenCode model is another provider's: a name that only ends in the same words does not resolve to the ZCode option.
    expect(consistentProvider(null, "zai-coding-plan/glm-5.3-flash")).toBeNull();
    expect(consistentProvider(null, "glm-5.3-flash")).toBe("zcode");
    for (const role of ["memory", "project-life", "docs-maintainer", "planner", "code-critic"]) expect(resolveRoleModel(role, {}).providerId, role).not.toBe("zcode");
  });

  it("validates the owner's row: the model, and only the efforts ZCode has", () => {
    const key = roleModelKey("memory");
    expect(roleModelProblem(key, { model: "glm-5.3-flash" })).toBeNull();
    expect(roleModelProblem(key, { model: "glm-5.3-flash", reasoning_effort: "max" })).toBeNull();
    expect(roleModelProblem(key, { model: "glm-5.3-flash", reasoning_effort: "medium" })).toContain("low, high, max");
    expect(roleModelProblem(key, { model: "zai-coding-plan/glm-5.3-flash" })).toContain("model: one of");
    expect(roleModelOption("glm-5.3-flash")?.providerId).toBe("zcode");
    expect(tableRowAt({ [key]: { model: "glm-5.3-flash", reasoning_effort: "medium" } }, "memory")).toMatchObject({ effort: null });
    expect(resolveRoleModel("memory", { [key]: { model: "glm-5.3-flash" } })).toMatchObject({ providerId: "zcode", model: "glm-5.3-flash", effort: "high", source: "table" });
  });

  it("falls to the role's own default when ZCode is not on offer here", () => {
    const settings = { [roleModelKey("memory")]: { model: "glm-5.3-flash" } };
    const run = (offered: boolean) => resolveAgentModel({ role: "memory", settings, pm: null, offered: (providerId) => (providerId === "zcode" ? offered : null) });
    expect(run(true)).toMatchObject({ providerId: "zcode", model: "glm-5.3-flash" });
    expect(run(false)).toMatchObject({ providerId: "claude-code", model: "claude-haiku-5-5", source: "role-default" });
    expect(run(false).issues).toContain("selection_unavailable");
  });
});

describe("when ZCode may take work", () => {
  const base = { settings: {}, catalog: catalogWith(["mini"]), hostId: "mini", now: at(16), busy: false };

  it("needs a machine whose provider list has zcode; an unknown catalog or host is a no", () => {
    expect(zcodeBlock(base)).toBeNull();
    expect(zcodeBlock({ ...base, hostId: "ovh" })).toMatchObject({ code: "host" });
    expect(zcodeBlock({ ...base, catalog: null })).toMatchObject({ code: "host" });
    expect(zcodeBlock({ ...base, hostId: null })).toMatchObject({ code: "host" });
    expect(zcodeBlock({ ...base, catalog: { hosts: [], providers: [] } })).toMatchObject({ code: "host" });
  });

  it("is offered 15:00-01:00 UTC only, unless zcode.window is always", () => {
    expect([inZcodePromo(at(14, 59)), inZcodePromo(at(15)), inZcodePromo(at(23, 59)), inZcodePromo(at(0, 30)), inZcodePromo(at(1))]).toEqual([false, true, true, true, false]);
    for (const hour of [1, 8, 14]) expect(zcodeBlock({ ...base, now: at(hour) }), String(hour)).toMatchObject({ code: "window", resetsAt: new Date(at(15)).toISOString() });
    expect(zcodeBlock({ ...base, now: at(20) })).toBeNull();
    expect(zcodeBlock({ ...base, now: at(0, 59) })).toBeNull();
    expect(zcodeBlock({ ...base, now: at(10), settings: { "zcode.window": "always" } })).toBeNull();
    expect(zcodeBlock({ ...base, now: at(10), settings: { "zcode.window": "promo" } })).toMatchObject({ code: "window" });
    expect(zcodeBlock({ ...base, now: at(10), settings: { "zcode.window": "nonsense" } })).toMatchObject({ code: "window" });
    expect(nextZcodePromoStart(at(16))).toBe(new Date(Date.UTC(2026, 9, 28, 15)).toISOString());
    expect(zcodeWindowMode({ "zcode.window": "always" })).toBe("always");
    expect(zcodeWindowMode({})).toBe("promo");
  });

  it("waits while another ZCode task runs (one slot)", () => {
    expect(zcodeBlock({ ...base, busy: true })).toMatchObject({ code: "busy" });
    expect(zcodeBlock({ ...base, busy: true, now: at(10) })).toMatchObject({ code: "window" });
  });

  it("validates the setting", () => {
    expect(zcodeWindowProblem(undefined)).toBeNull();
    expect(zcodeWindowProblem("")).toBeNull();
    expect(zcodeWindowProblem("promo")).toBeNull();
    expect(zcodeWindowProblem("always")).toBeNull();
    expect(zcodeWindowProblem("never")).toContain("promo, always");
  });
});

describe("the bridge's errors that are the machine's state, not the model's work", () => {
  it("reads busy, text-not-visible, foreground_required and session_expired in the bridge's own words", () => {
    expect(zcodeEnvironmentError("provider_error:ZCode is busy with another chat (one task at a time); try again in a few minutes.")).toMatch(/^ZCode is busy/);
    expect(zcodeEnvironmentError("provider_error:ZCode (text-not-visible): the answer is not on screen")).toMatch(/text-not-visible/);
    expect(zcodeEnvironmentError("turn_failed:ZCode (foreground_required): bring ZCode to the front")).toMatch(/foreground_required/);
    expect(zcodeEnvironmentError("Authentication required: sign in inside the ZCode app. ZCode (session_expired): login")).toMatch(/sign in inside the ZCode app/);
    expect(zcodeEnvironmentError("verification failed (npm test): expected session_expired to be handled")).toBeNull();
    expect(zcodeEnvironmentError("")).toBeNull();
    expect(zcodeEnvironmentError(null)).toBeNull();
  });
});
