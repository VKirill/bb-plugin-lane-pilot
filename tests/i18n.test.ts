import { describe, expect, it } from "vitest";
import { en, ru, setLocaleOverride, type I18nKey } from "../i18n";

describe("i18n dictionaries", () => {
  it("has the same keys in English and Russian with no empty strings", () => {
    setLocaleOverride(null);
    const enKeys = Object.keys(en).sort();
    const ruKeys = Object.keys(ru).sort();
    expect(ruKeys).toEqual(enKeys);
    for (const key of enKeys as I18nKey[]) {
      expect(en[key].length).toBeGreaterThan(0);
      expect(ru[key].length).toBeGreaterThan(0);
    }
  });
});
