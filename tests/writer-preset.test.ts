import { expect, it } from "vitest";
import { inheritProjectValues } from "../src/lp-defaults";
import { automaticEffortRoutingEnabled, writerServiceTier } from "../src/jev-reasoning";

it("gives an unconfigured project Luna high fast with explicit effort routing", () => {
  const result = inheritProjectValues({}, {});
  expect(result.values).toMatchObject({
    "writer.provider": "codex", "writer.model": "gpt-6-luna",
    "writer.reasoning_effort": "high", "writer.service_tier": "fast",
  });
  expect(automaticEffortRoutingEnabled(result.values)).toBe(false);
  expect(writerServiceTier(result.values)).toBe("fast");
  expect(result.explicitKeys).toEqual([]);
});

it("preserves project, global and legacy writer selections", () => {
  for (const [project, defaults] of [
    [{ "writer.provider": "opencode", "writer.model": "custom" }, {}],
    [{ writerProviderId: "codex", writerModel: "saved" }, {}],
    [{}, { writerProviderId: "codex", writerModel: "global" }],
  ] as const) {
    const { values } = inheritProjectValues(project, defaults);
    expect(values["writer.service_tier"]).toBeUndefined();
    expect(values["jev.LANE_JEV_EFFORT"]).toBeUndefined();
    expect(values["writer.model"]).not.toBe("gpt-6-luna");
  }
});

it("respects explicit effort, standard tier and Jev overrides", () => {
  const { values } = inheritProjectValues({
    "writer.reasoning_effort": "low", "writer.service_tier": "standard",
    "jev.LANE_JEV_EFFORT": true,
  }, {});
  expect(values["writer.reasoning_effort"]).toBe("low");
  expect(writerServiceTier(values)).toBe("standard");
  expect(automaticEffortRoutingEnabled(values)).toBe(true);
});
