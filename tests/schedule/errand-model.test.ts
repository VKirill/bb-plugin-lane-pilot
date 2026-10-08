import { describe, expect, it } from "vitest";
import { ERRAND_BUILTIN, errandDefaultProblem, parseErrandDefault, resolveErrandModel } from "../../src/rooms/schedule/errand-model";
import { errandTaskSchema, normalizeSchedule } from "../../src/rooms/schedule/model";
import { validateSettingValue, validateSettingsObject } from "../../src/setting-validation";

const KEY = "schedule.errand_default";
const resolve = (task: Parameters<typeof resolveErrandModel>[0]["task"] = {}, settings: Record<string, unknown> = {}, pm: { providerId: string; model: string } | null = null) => resolveErrandModel({ task, settings, pm });

describe("resolveErrandModel: the chain, level by level", () => {
  it("1. the task's own pair wins over everything below", () => {
    const got = resolve({ providerId: "codex", model: "gpt-6-luna", reasoning: "medium", serviceTier: "fast", preset: "strong" },
      { [KEY]: { provider: "claude-code", model: "x" }, "errand.model": "y" }, { providerId: "pm-p", model: "pm-m" });
    expect(got).toEqual({ providerId: "codex", model: "gpt-6-luna", reasoningEffort: "medium", serviceTier: "fast", source: "task", sourceKey: null, issues: [] });
  });

  it("1. a legacy model without a provider means claude-code, and the effort is the task's or the claude-code default", () => {
    expect(resolve({ model: "claude-sonnet-5-5", reasoning: "low" })).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5", reasoningEffort: "low", source: "task" });
    expect(resolve({ model: "claude-sonnet-5-5" })).toMatchObject({ providerId: "claude-code", reasoningEffort: "high", source: "task" });
  });

  it("1. a pair of another provider without an effort takes none, not a level it may not offer", () => {
    expect(resolve({ providerId: "acp-opencode", model: "router9/x" })).toMatchObject({ providerId: "acp-opencode", reasoningEffort: "none" });
  });

  it("1. a provider without a model is no pair: it is reported and the next level decides", () => {
    const got = resolve({ providerId: "codex" });
    expect(got).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", source: "errand-role" });
    expect(got.issues).toContain("provider_without_model");
  });

  it("2. the task's preset: the built-in default of the slug, an alias, and the owner's setting of that preset", () => {
    expect(resolve({ preset: "cheap-fast" })).toMatchObject({ providerId: "claude-code", model: "claude-haiku-5-5", reasoningEffort: "low", source: "preset", sourceKey: "cheap-fast" });
    expect(resolve({ preset: "INS - психология" })).toMatchObject({ providerId: "codex", model: "gpt-5.6-luna", reasoningEffort: "max", source: "preset", sourceKey: "ins-psychology" });
    expect(resolve({ preset: "strong" }, { "workflow.preset.strong.provider": "codex", "workflow.preset.strong.model": "gpt-6-sol", "workflow.preset.strong.reasoning_effort": "medium" }))
      .toMatchObject({ providerId: "codex", model: "gpt-6-sol", reasoningEffort: "medium", source: "preset" });
  });

  it("2. a preset sits under the task's pair and over the Automation default", () => {
    expect(resolve({ preset: "strong" }, { [KEY]: { provider: "codex", model: "gpt-6-luna" } })).toMatchObject({ source: "preset", model: "claude-opus-5-5" });
  });

  it("2. an unknown preset is reported and passed over", () => {
    const got = resolve({ preset: "nonsense" }, { [KEY]: { provider: "codex", model: "gpt-6-luna" } });
    expect(got).toMatchObject({ source: "schedule-default", model: "gpt-6-luna" });
    expect(got.issues).toContain("unknown_preset");
  });

  it("3. the Automation default as a pair, with its effort and fast mode; the task's reasoning and tier override those two fields only", () => {
    const settings = { [KEY]: { provider: "codex", model: "gpt-6-luna", reasoning_effort: "xhigh", service_tier: "fast" } };
    expect(resolve({}, settings)).toEqual({ providerId: "codex", model: "gpt-6-luna", reasoningEffort: "xhigh", serviceTier: "fast", source: "schedule-default", sourceKey: KEY, issues: [] });
    expect(resolve({ reasoning: "low", serviceTier: "default" }, settings)).toMatchObject({ providerId: "codex", model: "gpt-6-luna", reasoningEffort: "low", serviceTier: "default", source: "schedule-default" });
  });

  it("3. the Automation default as a preset", () => {
    expect(resolve({}, { [KEY]: { preset: "ins-digest" } })).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5", reasoningEffort: "medium", source: "schedule-default", sourceKey: KEY });
  });

  it("3. a stored default that is not valid is reported and passed over", () => {
    const got = resolve({}, { [KEY]: { provider: "codex" } });
    expect(got).toMatchObject({ source: "errand-role", model: "claude-opus-5-5" });
    expect(got.issues).toContain("invalid_schedule_default");
  });

  it("4. the errand role keys, and the built-in default when they are not set", () => {
    expect(resolve({}, { "errand.provider": "codex", "errand.model": "gpt-6-sol", "errand.reasoning_effort": "low" }))
      .toEqual({ providerId: "codex", model: "gpt-6-sol", reasoningEffort: "low", serviceTier: null, source: "errand-role", sourceKey: "errand.model", issues: [] });
    expect(resolve({}, { "errand.model": "claude-sonnet-5" })).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5", reasoningEffort: "high", sourceKey: "errand.model" });
    expect(resolve()).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", serviceTier: null, source: "errand-role", sourceKey: null, issues: [] });
    expect(resolve({}, { "errand.reasoning_effort": "max" })).toMatchObject({ model: "claude-opus-5-5", reasoningEffort: "max", sourceKey: null });
  });

  it("4. a role provider without a model is reported and the built-in default is used", () => {
    const got = resolve({}, { "errand.provider": "codex" });
    expect(got).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5" });
    expect(got.issues).toContain("provider_without_model");
  });

  it("5. the PM's model is the last resort, reached only when the role default has no model", () => {
    const pm = { providerId: "pm-p", model: "pm-m" };
    // The built-in default always has a model, so a caller never gets here today...
    expect(resolve({}, {}, pm)).toMatchObject({ source: "errand-role", model: "claude-opus-5-5" });
    // ...but a build without one falls through to the PM, and the effort is the provider's none (or high for claude-code).
    expect(resolveErrandModel({ task: {}, settings: {}, pm, builtin: null })).toEqual({ providerId: "pm-p", model: "pm-m", reasoningEffort: "none", serviceTier: null, source: "pm", sourceKey: null, issues: [] });
    expect(resolveErrandModel({ task: { reasoning: "high" }, settings: {}, pm, builtin: null })).toMatchObject({ source: "pm", reasoningEffort: "high" });
  });

  it("missing everything: the built-in default is returned and the gap is reported", () => {
    const got = resolveErrandModel({ task: {}, settings: {}, pm: null, builtin: null });
    expect(got).toMatchObject({ providerId: ERRAND_BUILTIN.providerId, model: ERRAND_BUILTIN.model });
    expect(got.issues).toContain("no_model");
  });

  it("an effort the spawn does not know is dropped for the provider's default", () => {
    expect(resolve({ model: "claude-sonnet-5", reasoning: "bogus" as never })).toMatchObject({ reasoningEffort: "high" });
  });
});

describe("schedule.errand_default: validation", () => {
  it("accepts a pair with an effort and a tier, a preset, and no value at all", () => {
    for (const value of [{ provider: "codex", model: "gpt-6-luna" }, { provider: "codex", model: "gpt-6-luna", reasoning_effort: "ultracode", service_tier: "fast" }, { preset: "strong" }, { preset: "INS - анализ" }, null, undefined, ""]) {
      expect(validateSettingValue(KEY, value), JSON.stringify(value)).toBeNull();
    }
  });

  it("refuses half a pair, an unknown effort, tier or preset, other keys and non-objects", () => {
    for (const value of [{ provider: "codex" }, { model: "x" }, { provider: "", model: "x" }, { provider: "a", model: "b", reasoning_effort: "max2" }, { provider: "a", model: "b", service_tier: "turbo" },
      { preset: "nope" }, { preset: "strong", provider: "a" }, { provider: "a", model: "b", extra: 1 }, "claude-code", 5, ["strong"]]) {
      expect(validateSettingValue(KEY, value), JSON.stringify(value)).toMatchObject({ code: "invalid_choice", key: KEY });
    }
  });

  it("is checked with the other settings, and parse keeps only a valid value", () => {
    expect(validateSettingsObject({ [KEY]: { preset: "nope" } })).toHaveLength(1);
    expect(validateSettingsObject({ [KEY]: { preset: "strong" } })).toEqual([]);
    expect(errandDefaultProblem({ preset: "nope" })).toMatch(/cheap-fast/);
    expect(parseErrandDefault({ preset: "INS - сводка" })).toEqual({ preset: "ins-digest" });
    expect(parseErrandDefault({ provider: "a", model: "b", service_tier: "fast" })).toEqual({ provider: "a", model: "b", service_tier: "fast" });
    expect(parseErrandDefault({ provider: "a" })).toBeNull();
    expect(parseErrandDefault(null)).toBeNull();
  });
});

describe("the errand task schema", () => {
  const base = { kind: "errand", task: "Check the leads and report the total." };

  it("keeps the legacy model + reasoning and takes the new fields", () => {
    expect(errandTaskSchema.parse({ ...base, model: "claude-opus-5-5", reasoning: "high" })).toMatchObject({ model: "claude-opus-5-5", reasoning: "high" });
    expect(errandTaskSchema.parse({ ...base, providerId: "codex", model: "gpt-6-luna", serviceTier: "fast", preset: "strong", reasoning: "ultracode" })).toMatchObject({ providerId: "codex", serviceTier: "fast", preset: "strong", reasoning: "ultracode" });
    expect(errandTaskSchema.safeParse({ ...base, serviceTier: "turbo" }).success).toBe(false);
    expect(errandTaskSchema.safeParse({ ...base, other: 1 }).success).toBe(false);
  });

  it("a whole definition with the new fields normalises", () => {
    const got = normalizeSchedule({ projectId: "p", name: "n", task: { ...base, providerId: "codex", model: "gpt-6-luna" }, when: { type: "cron", cron: "0 9 * * *", timezone: "UTC" } }, Date.now());
    expect(got.ok).toBe(true);
  });
});
