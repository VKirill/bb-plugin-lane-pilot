import { describe, expect, it } from "vitest";
import { validateSettingValue } from "../src/rooms/settings/setting-validation";

describe("validateSettingValue", () => {
  it("accepts any BB provider id for the specialist stage", () => {
    expect(validateSettingValue("specialist.provider", "claude-code")).toBeNull();
    expect(validateSettingValue("specialist.provider", "acp-cursor")).toBeNull();
  });

  it("accepts the ZCode window setting as promo or always, and refuses anything else", () => {
    for (const good of ["promo", "always", "", null]) expect(validateSettingValue("zcode.window", good), String(good)).toBeNull();
    expect(validateSettingValue("zcode.window", "never")).toMatchObject({ code: "invalid_choice", key: "zcode.window" });
    expect(validateSettingValue("zcode.window", true)).toMatchObject({ code: "invalid_choice" });
  });
});
