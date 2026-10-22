import { afterEach, describe, expect, it } from "vitest";
import { en, ru, setLocaleOverride } from "@lane-pilot/i18n";
import { SECTION_ORDER, VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";
import { JEV_KEYS, PICKER_KEYS, compatibilityAliasRows, extraSettingRows } from "../../src/rooms/ui-shell/ui/page-model";
import { settingLabel } from "../../src/rooms/settings/setting-copy";

afterEach(() => setLocaleOverride("en"));

describe("the settings copy after the tidy-up", () => {
  const aliases = new Set(compatibilityAliasRows().map((row) => row.id));
  // The rows the screen labels itself: model pickers carry their own labels, the two Jev environment switches are not shown as rows, the old adoc names are listed as names.
  const shown = VISIBLE_CATALOG.filter((row) => row.uiStatus === "editable" && !aliases.has(row.id) && !PICKER_KEYS.has(row.storageKey) && !JEV_KEYS.has(row.storageKey) && row.storageKey !== "writer.agent");

  it("no shown row is labelled with its raw key or with a command-line flag, in either language", () => {
    const bad: string[] = [];
    for (const locale of ["en", "ru"] as const) {
      setLocaleOverride(locale);
      for (const row of shown) {
        const label = settingLabel(row) ?? "";
        if (label === row.storageKey || label.startsWith("--") || label === row.setting) bad.push(`${locale} ${row.storageKey}: ${label}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every Russian label is Russian text where a plain word exists: it has a Cyrillic letter unless it is a product name", () => {
    setLocaleOverride("ru");
    const product = /^(Jev|TypeSafe|OpenLux|Telegram)/;
    const bad = shown.filter((row) => row.uiStatus === "editable").map((row) => [row.storageKey, settingLabel(row) ?? ""] as const)
      .filter(([, label]) => !/[А-Яа-я]/.test(label) && !product.test(label));
    expect(bad).toEqual([]);
  });

  it("the extra settings of the Work tab sit under headings that exist, and the three new headings have a Russian and an English title", () => {
    for (const section of ["limits", "gate", "files", "jev", "improvement"]) {
      expect(SECTION_ORDER).toContain(section);
      expect(en[`section_${section}` as keyof typeof en]).toBeTruthy();
      expect(ru[`section_${section}` as keyof typeof ru]).toBeTruthy();
    }
    const sectionOf = new Map(extraSettingRows().map((row) => [row.storageKey, row.section]));
    expect(sectionOf.get("run.max_attempts")).toBe("limits");
    expect(sectionOf.get("integration.gate_command")).toBe("gate");
    expect(sectionOf.get("bookkeeping.paths")).toBe("files");
    expect(sectionOf.get("jev.enabled")).toBe("jev");
    // Nothing is left under «Run operations» in the Work tab: it holds only the command-line flags of the old runner, which are diagnostics.
    expect([...sectionOf.values()]).not.toContain("ops");
  });

  it("an empty number stays empty: «no limit» is not shown as 0", async () => {
    const { FieldControl } = await import("../../src/rooms/settings/ui/setting-controls");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const row = VISIBLE_CATALOG.find((item) => item.storageKey === "run.max_attempts")!;
    const html = renderToStaticMarkup(createElement(FieldControl, { row, value: "", disabled: false, onChange: () => undefined }));
    expect(html).toMatch(/value=""/);
    expect(html).not.toMatch(/value="0"/);
  });
});
