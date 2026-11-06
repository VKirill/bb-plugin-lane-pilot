import { describe, expect, it } from "vitest";
import { resolveRoleModel } from "../../packages/models/src/role-models";
import { WALL_DEFAULTS, pickHunter } from "../../src/rooms/wall/config";

const fromRow = (settings: Record<string, unknown>) => () => {
  const row = resolveRoleModel("wall-hunter", settings) as unknown as { providerId?: string; provider?: string; model: string; reasoningEffort?: string; effort?: string };
  return { providerId: row.providerId ?? row.provider ?? "", model: row.model, reasoningEffort: row.reasoningEffort ?? row.effort ?? "" };
};

describe("the night wall hunter's model", () => {
  it("is the wall-hunter row of the role table when the wall config was not changed, and the row default is what the wall ran on", () => {
    expect(pickHunter(WALL_DEFAULTS, fromRow({})).model).toBe(WALL_DEFAULTS.hunterModel);
    const picked = pickHunter(WALL_DEFAULTS, fromRow({ "role_model.wall-hunter": { provider: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoning_effort: "medium" } }));
    expect(picked).toMatchObject({ model: "router9/ag/gemini-3.8-flash-high", reasoningLevel: "medium" });
  });

  it("keeps a wall config the owner changed over the role row", () => {
    const own = { ...WALL_DEFAULTS, hunterProviderId: "claude-code", hunterModel: "claude-opus-5-5" };
    expect(pickHunter(own, () => { throw new Error("the row must not be read"); })).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: WALL_DEFAULTS.hunterReasoningLevel });
  });
});
