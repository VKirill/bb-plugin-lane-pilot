/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { UNAPPLIED_REASON, SETTING_CATALOG, unappliedNotValidReason } from "../src/channels";
import { detectLocale, detectLocaleHint, en, localeFromSources, ru, setLocaleOverride, subscribeToLocaleHintChanges, unappliedReason, type I18nKey } from "../i18n";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function stubBrowserStorage(): void {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
  vi.stubGlobal("navigator", { language: "en-US" });
}

describe("i18n dictionaries", () => {
  it("uses the active Russianizer hint, then non-default document and browser locale", () => {
    expect(localeFromSources("ru-RU", "en-US", null)).toBe("en");
    expect(localeFromSources("ru-RU", null, null)).toBe("ru");
    expect(localeFromSources("en", "ru-RU", null)).toBe("ru");
    expect(localeFromSources(null, "ru-RU", null)).toBe("ru");
    expect(localeFromSources("", "ru-RU", null)).toBe("ru");
    expect(localeFromSources(null, null, "ru")).toBe("ru");
    expect(localeFromSources("en", "en-US", "ru")).toBe("ru");
    expect(localeFromSources("de", "ru-RU", null)).toBe("ru");
    expect(localeFromSources("ru", "en-US", null)).toBe("en");
    expect(localeFromSources("en", "en-US", "en")).toBe("en");
    expect(localeFromSources(null, null, null)).toBe("en");
  });
  it("treats the Russianizer as enabled by default and honors only an explicit off value", () => {
    stubBrowserStorage();
    Object.defineProperty(navigator, "language", { configurable: true, value: "en-US" });
    expect(detectLocaleHint()).toBe(navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en");
    const marker = document.createElement("li");
    marker.setAttribute("data-footer-item", "plugin:ru/toggle");
    document.body.append(marker);
    expect(detectLocaleHint()).toBe("ru");
    localStorage.setItem("bb-plugin-ru:enabled", "on");
    expect(detectLocaleHint()).toBe("ru");
    localStorage.setItem("bb-plugin-ru:enabled", "off");
    expect(detectLocaleHint()).toBe("en");
    marker.remove();
    localStorage.removeItem("bb-plugin-ru:enabled");
  });
  it("notifies auto consumers when the translated DOM changes locale", async () => {
    stubBrowserStorage();
    document.documentElement.lang = "en";
    Object.defineProperty(navigator, "language", { configurable: true, value: "en-US" });
    localStorage.setItem("bb-plugin-ru:enabled", "on");
    const marker = document.createElement("li");
    marker.setAttribute("data-footer-item", "plugin:ru/toggle");
    const changed: string[] = [];
    const dispose = subscribeToLocaleHintChanges((locale) => changed.push(locale));
    document.body.append(marker);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).toEqual(["ru"]);
    marker.remove();
    localStorage.removeItem("bb-plugin-ru:enabled");
    dispose();
  });
  it("shares an explicit locale override across plugin bundles", () => {
    setLocaleOverride("en");
    expect((globalThis as typeof globalThis & { __lanePilotLocaleOverride?: string }).__lanePilotLocaleOverride).toBe("en");
    expect(detectLocale()).toBe("en");
    setLocaleOverride(null);
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
