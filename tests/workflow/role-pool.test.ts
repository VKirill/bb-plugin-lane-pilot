import { describe, expect, it } from "vitest";
import { rankPool, resolveAgentModel, roleModelProblem, tablePoolAt } from "@lane-pilot/models";

/**
 * A row of the role table may share its work between several models (its pool): each run takes the least loaded provider, so the
 * helpers do not all land on one subscription. The cross-family rule and the limits still apply on top.
 */
const row = { model: "claude-sonnet-5-5", reasoning_effort: "medium", pool: [{ model: "gpt-6.1-terra" }, { model: "router9/ag/gemini-3.8-flash-high" }] };
const settings = { "role_model.errand": row };
const load = (table: Record<string, { percent: number | null; recent: number }>) => (providerId: string) => table[providerId] ?? { percent: null, recent: 0 };

describe("a role with a pool of models", () => {
  it("is a valid row, and its pool drops what is not a table model or repeats the row's model", () => {
    expect(roleModelProblem("role_model.errand", row)).toBeNull();
    expect(roleModelProblem("role_model.errand", { ...row, pool: [{ model: "made-up" }] })).toMatch(/^pool: model/);
    expect(roleModelProblem("role_model.errand", { ...row, pool: "gpt-6.1-terra" })).toMatch(/^pool/);
    expect(tablePoolAt({ "role_model.errand": { ...row, pool: [{ model: "claude-sonnet-5-5" }, { model: "x" }, { model: "gpt-6.1-terra" }, { model: "gpt-6.1-terra" }] } }, "errand").map((p) => p.option.id)).toEqual(["gpt-6.1-terra"]);
  });

  it("gives the run to the provider with the most room, then to the one with fewer recent starts", () => {
    const pick = (table: Parameters<typeof load>[0]) => resolveAgentModel({ role: "errand", settings, pm: null, load: load(table) });
    expect(pick({ "claude-code": { percent: 70, recent: 0 }, codex: { percent: 20, recent: 0 }, opencode2: { percent: 25, recent: 0 } }).model).toBe("gpt-6.1-terra");
    expect(pick({ "claude-code": { percent: 20, recent: 5 }, codex: { percent: 22, recent: 2 }, opencode2: { percent: 21, recent: 1 } }).model).toBe("router9/ag/gemini-3.8-flash-high");
    // Without readings the row's own model runs, as before pools.
    expect(resolveAgentModel({ role: "errand", settings, pm: null }).model).toBe("claude-sonnet-5-5");
  });

  it("puts a spent provider last", () => {
    const rows = [{ providerId: "claude-code", model: "a" }, { providerId: "codex", model: "b" }];
    const ranked = rankPool(rows, () => ({ percent: 0, recent: 0 }), (providerId) => (providerId === "claude-code" ? { percent: 95, window: "week" } : null));
    expect(ranked.map((r) => r.providerId)).toEqual(["codex", "claude-code"]);
  });

  it("a row without a pool, or a role on its built-in default, is not touched", () => {
    const busy = load({ "claude-code": { percent: 90, recent: 9 } });
    expect(resolveAgentModel({ role: "errand", settings: { "role_model.errand": { model: "claude-sonnet-5-5" } }, pm: null, load: busy }).model).toBe("claude-sonnet-5-5");
    expect(resolveAgentModel({ role: "errand", settings: {}, pm: null, load: busy }).model).toBe("claude-sonnet-5-5");
  });

  it("takes any provider's model from BB's own window: the row and its pool name the provider", () => {
    const any = { provider: "acp-cursor", model: "grok-4.6", reasoning_effort: "high", pool: [{ provider: "opencode2", model: "zai-coding-plan/glm-5.3-flash" }] };
    expect(roleModelProblem("role_model.errand", any)).toBeNull();
    // A model that is not in the table needs its provider; a provider that is not a string is refused.
    expect(roleModelProblem("role_model.errand", { model: "grok-4.6" })).toMatch(/^model:/);
    expect(roleModelProblem("role_model.errand", { provider: 7, model: "grok-4.6" })).toMatch(/^provider/);
    const picked = resolveAgentModel({ role: "errand", settings: { "role_model.errand": any }, pm: null, load: load({ "acp-cursor": { percent: 80, recent: 0 }, opencode2: { percent: 10, recent: 0 } }) });
    expect(picked).toMatchObject({ providerId: "opencode2", model: "zai-coding-plan/glm-5.3-flash", source: "table" });
    expect(resolveAgentModel({ role: "errand", settings: { "role_model.errand": any }, pm: null })).toMatchObject({ providerId: "acp-cursor", model: "grok-4.6", reasoningEffort: "high" });
  });
});
