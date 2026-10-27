import { describe, expect, it } from "vitest";
import {
  ROLE_IDS, ROLE_MODEL_OPTIONS, ROLE_TABLE, WRITER_PROFILES, crossFamilyPeer, judgeAgainstAuthor, modelFamily, modelTier, resolveRoleModel, roleModelKey, roleModelProblem,
  roleModelOption, roleRowOf,
} from "@lane-pilot/models";

describe("the table «role -> model»", () => {
  it("offers only the six Claude and GPT models, with the provider ids the machines use, and each is a model the writers' anamnesis knows", () => {
    expect(ROLE_MODEL_OPTIONS.map((option) => `${option.providerId}/${option.id}`)).toEqual([
      "claude-code/claude-opus-5-5", "claude-code/claude-sonnet-5-5", "claude-code/claude-haiku-5-5", "codex/gpt-6.1-sol", "codex/gpt-6.1-terra", "codex/gpt-6-luna",
    ]);
    for (const option of ROLE_MODEL_OPTIONS) {
      const profile = WRITER_PROFILES.find((row) => row.model === option.id);
      expect(profile, option.id).toMatchObject({ providerId: option.providerId });
      expect(modelTier(option.id), option.id).toBe(option.tier);
      expect(modelFamily(option.id)).toBe(option.family);
    }
  });

  it("has a built-in default for every role that is one of the options, with a reason, and judges on the other family than the authors", () => {
    expect(new Set(ROLE_IDS).size).toBe(ROLE_TABLE.length);
    for (const row of ROLE_TABLE) {
      expect(roleModelOption(row.default.model), row.id).toBeTruthy();
      expect(row.default.why.length, row.id).toBeGreaterThan(20);
    }
    const family = (role: string) => modelFamily(ROLE_TABLE.find((row) => row.id === role)!.default.model);
    for (const author of ["analyst", "planner", "workflow-architect", "specialist"]) expect(family(author), author).toBe("claude");
    for (const judge of ["plan-critic", "specialist-reviewer", "code-critic", "auditor", "debugger", "council"]) expect(family(judge), judge).toBe("gpt");
    // A role that decides is never left on a light model by default.
    for (const row of ROLE_TABLE) if (row.least) expect(["light"].includes(roleModelOption(row.default.model)!.tier), row.id).toBe(false);
  });

  it("reads a role name the way a graph writes it", () => {
    expect(roleRowOf("specialist:design-lead")).toBe("specialist");
    expect(roleRowOf("specialist:anything-the-owner-made")).toBe("specialist");
    expect(roleRowOf("code-critic")).toBe("code-critic");
    expect(roleRowOf("gate-triage")).toBe("triager");
    expect(roleRowOf("night-reviewer")).toBe("auditor");
    expect(roleRowOf("worker")).toBe("analyst");
    expect(roleRowOf("never-heard-of-it")).toBe("analyst");
  });

  it("resolves: the owner's row, then a stage selection set earlier (not below the role's least tier), then the default", () => {
    expect(resolveRoleModel("code-critic", {})).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", effort: "high", source: "default", sourceKey: null });
    expect(resolveRoleModel("code-critic", { [roleModelKey("code-critic")]: { model: "claude-opus-5-5", reasoning_effort: "xhigh" } }))
      .toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", effort: "xhigh", source: "table", sourceKey: "role_model.code-critic" });
    const stage = { "code_critique.provider": "codex", "code_critique.model": "gpt-6.1-terra", "code_critique.reasoning_effort": "low" };
    expect(resolveRoleModel("code-critic", stage)).toMatchObject({ model: "gpt-6.1-terra", effort: "low", source: "stage", sourceKey: "code_critique.model" });
    // A stage selection below the role's least tier is passed over, and says so.
    expect(resolveRoleModel("code-critic", { "code_critique.provider": "codex", "code_critique.model": "gpt-6-luna" })).toMatchObject({ model: "gpt-6.1-sol", source: "default", escalated: true });
    // The table wins over the stage selection; a row that is not one of the six is no row.
    expect(resolveRoleModel("code-critic", { ...stage, [roleModelKey("code-critic")]: { model: "claude-sonnet-5-5" } })).toMatchObject({ model: "claude-sonnet-5-5", source: "table" });
    expect(resolveRoleModel("code-critic", { ...stage, [roleModelKey("code-critic")]: { model: "gemini-9" } })).toMatchObject({ model: "gpt-6.1-terra", source: "stage" });
  });

  it("validates a stored row: one of the roles, one of the six models, one of the efforts", () => {
    expect(roleModelProblem(roleModelKey("analyst"), { model: "claude-opus-5-5", reasoning_effort: "max" })).toBeNull();
    expect(roleModelProblem(roleModelKey("analyst"), null)).toBeNull();
    expect(roleModelProblem(roleModelKey("analyst"), { model: "claude-opus-5" })).toContain("model: one of");
    expect(roleModelProblem(roleModelKey("analyst"), { model: "claude-opus-5-5", reasoning_effort: "ultra" })).toContain("reasoning_effort");
    expect(roleModelProblem(roleModelKey("analyst"), { model: "claude-opus-5-5", provider: "codex" })).toContain("{model");
    expect(roleModelProblem("role_model.nobody", { model: "claude-opus-5-5" })).toContain("role: one of");
  });
});

describe("the cross-family rule for a judge", () => {
  const sol = { providerId: "codex", model: "gpt-6.1-sol" };
  const opus = { providerId: "claude-code", model: "claude-opus-5-5" };

  it("pairs the models by strength across the families", () => {
    expect(crossFamilyPeer("claude-opus-5-5")).toEqual(sol);
    expect(crossFamilyPeer("gpt-6.1-sol")).toEqual(opus);
    expect(crossFamilyPeer("claude-sonnet-5-5")).toEqual({ providerId: "codex", model: "gpt-6.1-terra" });
    expect(crossFamilyPeer("gpt-6-luna")).toEqual({ providerId: "claude-code", model: "claude-haiku-5-5" });
    expect(crossFamilyPeer("composer-2.5")).toBeNull();
  });

  it("puts the judge on GPT when the author is a Claude model, and on Claude when the author is a GPT model", () => {
    expect(judgeAgainstAuthor(sol, opus)).toEqual({ ...sol, changed: false });
    expect(judgeAgainstAuthor(sol, { providerId: "claude-code", model: "claude-sonnet-5-5" }).changed).toBe(false);
    expect(judgeAgainstAuthor(sol, { providerId: "codex", model: "gpt-6-luna" })).toEqual({ ...opus, changed: true });
    expect(judgeAgainstAuthor(sol, { providerId: "codex", model: "gpt-6.1-sol" })).toEqual({ ...opus, changed: true });
    // A judge the owner put on Claude meets a Claude author: it moves to GPT.
    expect(judgeAgainstAuthor(opus, { providerId: "claude-code", model: "claude-haiku-5-5" })).toEqual({ ...sol, changed: true });
  });

  it("leaves the judge alone when the author's family is unknown (Composer, Gemini) or there is no author yet", () => {
    for (const author of [{ providerId: "acp-cursor", model: "composer-2.5" }, { providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high" }, null]) {
      expect(judgeAgainstAuthor(sol, author), JSON.stringify(author)).toEqual({ ...sol, changed: false });
    }
  });
});
