import { describe, expect, it } from "vitest";
import {
  ROLE_IDS, ROLE_MODEL_OPTIONS, ROLE_TABLE, WRITER_PROFILES, consistentProvider, crossFamilyPeer, crossFamilyPeers, judgeAgainstAuthor, modelFamily, modelTier, offeredForRole, peerOffSpent,
  resolveRoleModel, roleFallbackModel, roleModelKey, roleModelProblem, roleModelOption, roleRowOf, type ModelCatalog,
} from "@lane-pilot/models";

describe("the table «role -> model»", () => {
  it("offers only the Claude, GPT, Gemini Flash (9router) and ZCode GLM-5.3-Flash models, with the provider ids the machines use, and each is a model the writers' anamnesis knows", () => {
    expect(ROLE_MODEL_OPTIONS.map((option) => `${option.providerId}/${option.id}`)).toEqual([
      "claude-code/claude-fable-5-1", "claude-code/claude-opus-5-5", "claude-code/claude-sonnet-5-5", "claude-code/claude-haiku-5-5", "codex/gpt-6.1-sol", "codex/gpt-6.1-terra", "codex/gpt-6-astra", "codex/gpt-6-luna",
      "opencode2/router9/ag/gemini-3.8-flash-high", "zcode/glm-5.3-flash",
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
    // The reviews run on the Gemini subscription (owner, 2026-10-27); the auditor, the debugger and the chair stay on GPT.
    for (const judge of ["plan-critic", "specialist-reviewer", "code-critic", "triager"]) expect(family(judge), judge).toBe("google");
    for (const judge of ["auditor", "debugger", "council"]) expect(family(judge), judge).toBe("gpt");
    // A row whose default is a Gemini names the GPT model it falls to, and that one is another family than the Gemini.
    for (const row of ROLE_TABLE) {
      if (modelFamily(row.default.model) === "google") expect(modelFamily(roleFallbackModel(row.id)?.model), row.id).toBe("gpt");
      else expect(row.fallback, row.id).toBeUndefined();
    }
    expect(roleFallbackModel("code-critic")).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", effort: "high" });
    expect(roleFallbackModel("triager")).toMatchObject({ model: "gpt-6-luna" });
    expect(roleFallbackModel("auditor")).toBeNull();
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
    expect(resolveRoleModel("code-critic", {})).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", effort: "medium", source: "default", sourceKey: null });
    expect(resolveRoleModel("plan-critic", {})).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", effort: "medium" });
    expect(resolveRoleModel("auditor", {})).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", effort: "high" });
    expect(resolveRoleModel("code-critic", { [roleModelKey("code-critic")]: { model: "claude-opus-5-5", reasoning_effort: "xhigh" } }))
      .toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", effort: "xhigh", source: "table", sourceKey: "role_model.code-critic" });
    const stage = { "code_critique.provider": "codex", "code_critique.model": "gpt-6.1-terra", "code_critique.reasoning_effort": "low" };
    expect(resolveRoleModel("code-critic", stage)).toMatchObject({ model: "gpt-6.1-terra", effort: "low", source: "stage", sourceKey: "code_critique.model" });
    // A stage selection below the role's least tier is passed over, and says so.
    expect(resolveRoleModel("code-critic", { "code_critique.provider": "codex", "code_critique.model": "gpt-6-luna" })).toMatchObject({ model: "router9/ag/gemini-3.8-flash-high", source: "default", escalated: true });
    // The owner picks the Gemini for a row that runs on Opus: the effort is the model's own default, not the row's «high».
    expect(resolveRoleModel("analyst", { [roleModelKey("analyst")]: { model: "router9/ag/gemini-3.8-flash-high" } })).toMatchObject({ providerId: "opencode2", effort: "medium", source: "table" });
    expect(resolveRoleModel("analyst", { [roleModelKey("analyst")]: { model: "router9/ag/gemini-3.8-flash-high", reasoning_effort: "high" } })).toMatchObject({ effort: "high" });
    // The table wins over the stage selection; a row that is not one of the six is no row.
    expect(resolveRoleModel("code-critic", { ...stage, [roleModelKey("code-critic")]: { model: "claude-sonnet-5-5" } })).toMatchObject({ model: "claude-sonnet-5-5", source: "table" });
    expect(resolveRoleModel("code-critic", { ...stage, [roleModelKey("code-critic")]: { model: "gemini-9" } })).toMatchObject({ model: "gpt-6.1-terra", source: "stage" });
  });

  it("validates a stored row: one of the roles, one of the six models, one of the efforts", () => {
    expect(roleModelProblem(roleModelKey("analyst"), { model: "claude-opus-5-5", reasoning_effort: "max" })).toBeNull();
    expect(roleModelProblem(roleModelKey("analyst"), null)).toBeNull();
    expect(roleModelProblem(roleModelKey("code-critic"), { model: "router9/ag/gemini-3.8-flash-high", reasoning_effort: "medium" })).toBeNull();
    expect(roleModelProblem(roleModelKey("code-critic"), { model: "gemini-3.8-flash-high" })).toContain("model: one of");
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

  it("leaves the judge alone when the author's family is unknown (Composer) or there is no author yet, and when the author is another family (Gemini)", () => {
    for (const author of [{ providerId: "acp-cursor", model: "composer-2.5" }, { providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high" }, null]) {
      expect(judgeAgainstAuthor(sol, author), JSON.stringify(author)).toEqual({ ...sol, changed: false });
    }
  });
});

describe("the third family: Gemini 3.8 Flash through 9router", () => {
  const gemini = { providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high" };
  const sol = { providerId: "codex", model: "gpt-6.1-sol" };
  const opus = { providerId: "claude-code", model: "claude-opus-5-5" };

  it("is recognised as its own family by id and by name, and runs on opencode2", () => {
    expect(modelFamily(gemini.model)).toBe("google");
    expect(modelFamily("router9/ag/gemini-3.8-flash-low")).toBe("google");
    expect(modelFamily("openrouter/~google/gemini-pro-latest")).toBe("google");
    expect(modelFamily("composer-2.5")).toBeNull();
    expect(modelTier(gemini.model)).toBe("standard");
    expect(consistentProvider(undefined, gemini.model)).toBe("opencode2");
    expect(consistentProvider("claude-code", gemini.model)).toBe("opencode2");
    expect(consistentProvider("codex", gemini.model)).toBe("opencode2");
  });

  it("has Sol as its peer, then Opus; Claude and GPT keep their pairs (the pairs of two families do not change)", () => {
    expect(crossFamilyPeer(gemini.model)).toEqual(sol);
    expect(crossFamilyPeers(gemini.model)).toEqual([sol, opus]);
    expect(crossFamilyPeers("claude-opus-5-5")).toEqual([sol]);
    expect(crossFamilyPeers("gpt-6.1-sol")).toEqual([opus]);
    // The author's family comes last, never first: a Gemini judge of a GPT author prefers Opus when Opus is the other choice.
    expect(crossFamilyPeers(gemini.model, "gpt")).toEqual([opus, sol]);
    expect(crossFamilyPeers(gemini.model, "claude")).toEqual([sol, opus]);
  });

  it("puts a Gemini judge of Gemini work on Sol, else on Opus when Sol is not offered, and never on its author's family while another is offered", () => {
    expect(judgeAgainstAuthor(gemini, gemini)).toEqual({ ...sol, changed: true });
    expect(judgeAgainstAuthor(gemini, gemini, (providerId) => providerId !== "codex")).toEqual({ ...opus, changed: true });
    // Nothing offered: the first peer, so the caller sees it is not on offer and says the judge is not independent.
    expect(judgeAgainstAuthor(gemini, gemini, () => false)).toEqual({ ...sol, changed: true });
    // Claude and GPT authors are other families than the Gemini judge: it stays.
    expect(judgeAgainstAuthor(gemini, opus)).toEqual({ ...gemini, changed: false });
    expect(judgeAgainstAuthor(gemini, sol)).toEqual({ ...gemini, changed: false });
    // A Claude or GPT judge meets a Gemini author: another family already, it stays (no peer is needed).
    expect(judgeAgainstAuthor(opus, gemini)).toEqual({ ...opus, changed: false });
    expect(judgeAgainstAuthor(sol, gemini)).toEqual({ ...sol, changed: false });
  });

  it("moves a spent Gemini to Sol, to Opus when Sol is spent too, and stays when neither is free", () => {
    const window = { percent: 99, window: "weekly" };
    expect(peerOffSpent(gemini, (providerId) => (providerId === "opencode2" ? window : null))).toMatchObject({ ...sol, issue: expect.stringContaining("opencode2 weekly 99%") });
    // Sol spent as well: Opus, when it has room and is offered; not offered, or spent too: the Gemini stays (the limit is only an ordering).
    expect(peerOffSpent(gemini, (providerId) => (providerId === "claude-code" ? null : window))).toMatchObject(opus);
    expect(peerOffSpent(gemini, (providerId) => (providerId === "claude-code" ? null : window), (providerId) => providerId !== "claude-code")).toBeNull();
    expect(peerOffSpent(gemini, () => window)).toBeNull();
    expect(peerOffSpent(gemini, () => null)).toBeNull();
    // A row that names its fallback (the triager: Luna) goes there first.
    const luna = { providerId: "codex", model: "gpt-6-luna" };
    expect(peerOffSpent(gemini, (providerId) => (providerId === "opencode2" ? window : null), undefined, undefined, luna)).toMatchObject(luna);
    expect(peerOffSpent(opus, (providerId) => (providerId === "claude-code" ? window : null), undefined, undefined, luna)).toMatchObject(sol);
    // With a GPT author the independent peer is Opus: it comes first.
    expect(peerOffSpent(gemini, (providerId) => (providerId === "opencode2" ? window : null), undefined, "gpt")).toMatchObject(opus);
  });

  it("is offered only where the machine lists it: a connected machine without it does not offer it", () => {
    const catalog = (models: string[]): ModelCatalog => ({
      hosts: [{ id: "mac", name: "Mac", connected: true }, { id: "off", name: "Off", connected: false }],
      providers: [
        { id: "opencode2", displayName: "OpenCode", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mac"],
          models: models.map((id) => ({ id, model: id, displayName: id, efforts: ["medium"], defaultEffort: "medium", isDefault: false, hostIds: ["mac"] })) },
        { id: "codex", displayName: "Codex", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mac"], models: [] },
      ],
    });
    expect(offeredForRole(catalog([gemini.model]), "opencode2", gemini.model, "mac")).toBe(true);
    expect(offeredForRole(catalog([]), "opencode2", gemini.model, "mac")).toBe(false);
    expect(offeredForRole(catalog([]), "opencode2", gemini.model, "off")).toBeNull();
    expect(offeredForRole(catalog([]), "opencode2", gemini.model, null)).toBeNull();
    // Claude and GPT stay unknown when the catalog does not list them (the native providers are everywhere).
    expect(offeredForRole(catalog([]), "codex", "gpt-6.1-sol", "mac")).toBeNull();
  });
});
