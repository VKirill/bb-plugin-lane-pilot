import { describe, expect, it } from "vitest";
import { UNAPPLIED_REASON, SETTING_CATALOG, unappliedNotValidReason } from "../src/channels";
import { detectLocale, en, localeFromSources, ru, setLocaleOverride, unappliedReason, type I18nKey } from "../i18n";

describe("i18n dictionaries", () => {
  it("uses the BB document language first and browser language as fallback", () => {
    expect(localeFromSources("ru-RU", "en", "en-US")).toBe("ru");
    expect(localeFromSources(null, "ru-RU", "en-US")).toBe("ru");
    expect(localeFromSources(null, "", "ru-RU")).toBe("ru");
    expect(localeFromSources(null, "", "en-US")).toBe("en");
  });
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

  it("translates every catalog unapplied reason in Russian", () => {
    setLocaleOverride("ru");
    for (const reason of Object.values(UNAPPLIED_REASON)) {
      const translated = unappliedReason(reason);
      expect(translated).not.toBe(reason);
      expect(translated.length).toBeGreaterThan(0);
    }
    for (const spec of SETTING_CATALOG) {
      if (spec.channel !== "NONE" || !spec.reason) continue;
      expect(unappliedReason(spec.reason)).not.toBe(spec.reason);
    }
    const dynamic = unappliedNotValidReason(
      { key: "ops.poll_interval", channel: "OPS-DIRECT", flag: "--poll-interval" },
      "lane-ctl",
      "status",
    );
    expect(unappliedReason(dynamic)).toMatch(/недопустим/);
    setLocaleOverride(null);
  });
});
