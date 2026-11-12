import { expect, it } from "vitest";
import { inheritProjectValues } from "@lane-pilot/settings-catalog";
import { writerServiceTier } from "@lane-pilot/models";

it("gives an unconfigured project Luna high fast with a fixed effort", () => {
  const result = inheritProjectValues({}, {});
  expect(result.values).toMatchObject({
    "writer.provider": "codex", "writer.model": "gpt-6-luna",
    "writer.reasoning_effort": "high", "writer.service_tier": "fast",
  });
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
    expect(values["writer.model"]).not.toBe("gpt-6-luna");
  }
});

it("respects explicit effort and standard tier", () => {
  const { values } = inheritProjectValues({
    "writer.reasoning_effort": "low", "writer.service_tier": "standard",
  }, {});
  expect(values["writer.reasoning_effort"]).toBe("low");
  expect(writerServiceTier(values)).toBe("standard");
});
