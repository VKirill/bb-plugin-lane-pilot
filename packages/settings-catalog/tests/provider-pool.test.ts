import { describe, expect, it } from "vitest";
import { parseProviderPools, providerPoolCap, providerPoolProblem } from "@lane-pilot/settings-catalog";
import { validateSettingValue } from "../../../src/rooms/settings/setting-validation";

describe("provider pool setting", () => {
  it("reads pairs, lines and a JSON object", () => {
    expect(parseProviderPools("codex=2, claude-code=3").pools).toEqual({ codex: 2, "claude-code": 3 });
    expect(parseProviderPools("codex:2\nopencode = 1").pools).toEqual({ codex: 2, opencode: 1 });
    expect(parseProviderPools('{"codex":2,"x":"4"}').pools).toEqual({ codex: 2, x: 4 });
    expect(parseProviderPools({ codex: 5 }).pools).toEqual({ codex: 5 });
  });

  it("sets no cap when the setting is empty, missing, or lists another provider", () => {
    expect(providerPoolCap({}, "codex")).toBeNull();
    expect(providerPoolCap({ "ops.provider_pool": "" }, "codex")).toBeNull();
    expect(providerPoolCap({ "ops.provider_pool": "opencode=2" }, "codex")).toBeNull();
    expect(providerPoolCap({ "ops.provider_pool": "opencode=2, codex=4" }, "codex")).toBe(4);
  });

  it("ignores a malformed entry at run time and refuses it when saved", () => {
    expect(providerPoolCap({ "ops.provider_pool": "codex=0, opencode=2" }, "codex")).toBeNull();
    expect(providerPoolCap({ "ops.provider_pool": "codex=0, opencode=2" }, "opencode")).toBe(2);
    expect(providerPoolProblem("codex=16")).toContain("codex=16");
    expect(providerPoolProblem("codex")).toContain("codex");
    expect(providerPoolProblem("{broken")).toBeTruthy();
    expect(providerPoolProblem("codex=2")).toBeNull();
    expect(providerPoolProblem("")).toBeNull();
    expect(validateSettingValue("ops.provider_pool", "codex=99")).toMatchObject({ code: "invalid_choice", key: "ops.provider_pool" });
    expect(validateSettingValue("ops.provider_pool", "codex=2")).toBeNull();
  });
});
