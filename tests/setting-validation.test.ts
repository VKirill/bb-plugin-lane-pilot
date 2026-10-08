import { describe, expect, it } from "vitest";
import { validateSettingValue } from "../src/rooms/settings/setting-validation";

describe("validateSettingValue", () => {
  it("accepts any BB provider id for the specialist stage", () => {
    expect(validateSettingValue("specialist.provider", "claude-code")).toBeNull();
    expect(validateSettingValue("specialist.provider", "acp-cursor")).toBeNull();
  });
});
