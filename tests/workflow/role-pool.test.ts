import { describe, expect, it } from "vitest";
import { rankPool, resolveAgentModel, roleModelProblem, tablePoolAt } from "@lane-pilot/models";

/**
 * A row of the role table may name fallbacks (its pool): the row's model always runs first, a fallback only when the one before it is
 * spent (its usage window, or a limit a helper just hit). The owner's choice of 2026-11-04, as the writer's fallbacks work.
 */
const row = { model: "claude-sonnet-5-5", reasoning_effort: "medium", pool: [{ model: "gpt-6.1-terra" }, { model: "router9/ag/gemini-3.8-flash-high" }] };
const settings = { "role_model.errand": row };
const spentOn = (...providers: string[]) => (providerId: string) => (providers.includes(providerId) ? { percent: 100, window: "limit" } : null);

describe("a role with a pool of models", () => {
  it("is a valid row, and its pool drops what is not a table model or repeats the row's model", () => {
    expect(roleModelProblem("role_model.errand", row)).toBeNull();
    expect(roleModelProblem("role_model.errand", { ...row, pool: [{ model: "made-up" }] })).toMatch(/^pool: model/);
    expect(roleModelProblem("role_model.errand", { ...row, pool: "gpt-6.1-terra" })).toMatch(/^pool/);
    expect(tablePoolAt({ "role_model.errand": { ...row, pool: [{ model: "claude-sonnet-5-5" }, { model: "x" }, { model: "gpt-6.1-terra" }, { model: "gpt-6.1-terra" }] } }, "errand").map((p) => p.option.id)).toEqual(["gpt-6.1-terra"]);
  });

  it("runs the row's model first however busy it is; a fallback runs only when every model before it is spent", () => {
    expect(resolveAgentModel({ role: "errand", settings, pm: null }).model).toBe("claude-sonnet-5-5");
    expect(resolveAgentModel({ role: "errand", settings, pm: null, spent: spentOn() }).model).toBe("claude-sonnet-5-5");
    expect(resolveAgentModel({ role: "errand", settings, pm: null, spent: spentOn("claude-code") }).model).toBe("gpt-6.1-terra");
    expect(resolveAgentModel({ role: "errand", settings, pm: null, spent: spentOn("claude-code", "codex") }).model).toBe("router9/ag/gemini-3.8-flash-high");
  });

  it("puts a spent provider last and keeps the owner's order of the rest", () => {
    const rows = [{ providerId: "claude-code", model: "a" }, { providerId: "codex", model: "b" }, { providerId: "opencode2", model: "c" }];
    expect(rankPool(rows, spentOn("claude-code")).map((r) => r.providerId)).toEqual(["codex", "opencode2", "claude-code"]);
    expect(rankPool(rows, spentOn()).map((r) => r.providerId)).toEqual(["claude-code", "codex", "opencode2"]);
  });

  it("a row without a pool, or a role on its built-in default, is not touched", () => {
    expect(resolveAgentModel({ role: "errand", settings: { "role_model.errand": { model: "claude-sonnet-5-5" } }, pm: null }).model).toBe("claude-sonnet-5-5");
    expect(resolveAgentModel({ role: "errand", settings: {}, pm: null }).model).toBe("claude-sonnet-5-5");
  });

  it("takes any provider's model from BB's own window: the row and its pool name the provider", () => {
    const any = { provider: "acp-cursor", model: "grok-4.6", reasoning_effort: "high", pool: [{ provider: "opencode2", model: "zai-coding-plan/glm-5.3-flash" }] };
    expect(roleModelProblem("role_model.errand", any)).toBeNull();
    // A model that is not in the table needs its provider; a provider that is not a string is refused.
    expect(roleModelProblem("role_model.errand", { model: "grok-4.6" })).toMatch(/^model:/);
    expect(roleModelProblem("role_model.errand", { provider: 7, model: "grok-4.6" })).toMatch(/^provider/);
    const picked = resolveAgentModel({ role: "errand", settings: { "role_model.errand": any }, pm: null, spent: spentOn("acp-cursor") });
    expect(picked).toMatchObject({ providerId: "opencode2", model: "zai-coding-plan/glm-5.3-flash", source: "table" });
    expect(resolveAgentModel({ role: "errand", settings: { "role_model.errand": any }, pm: null })).toMatchObject({ providerId: "acp-cursor", model: "grok-4.6", reasoningEffort: "high" });
  });

  it("a Claude Code profile role keeps only the Claude models of its pool", () => {
    const pooled = { "role_model.specialist": { model: "claude-opus-5-5", pool: [{ model: "gpt-6.1-sol" }, { model: "claude-sonnet-5-5" }] } };
    const opusSpent = (_providerId: string, model: string) => (model === "claude-opus-5-5" ? { percent: 100, window: "limit" } : null);
    expect(resolveAgentModel({ role: "specialist", settings: pooled, pm: null, spent: opusSpent })).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5" });
  });
});
