import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, priceFor } from "@lane-pilot/models";
import { DEFAULT_MODEL } from "../../src/rooms/workflow/server/workflow-agent-model";

describe("the price table", () => {
  it("prices every model a built-in preset and the helpers' default run on (an unpriced one counts as the dearest)", () => {
    const models = [...new Set([...Object.values(BUILTIN_PRESETS).map((preset) => preset.model), DEFAULT_MODEL])];
    expect(models.filter((model) => !priceFor(model))).toEqual([]);
  });
});
