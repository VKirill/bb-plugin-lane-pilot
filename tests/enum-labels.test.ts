import { describe, expect, it } from "vitest";
import { en, ru, setLocaleOverride } from "../i18n";
import { VISIBLE_CATALOG } from "../src/ui-catalog";
import { enumLabelKnown, isBrandEnumValue, presentEnumLabel } from "../src/enum-labels";

describe("enum presentation labels", () => {
  it("keeps storage codes and localizes working labels in EN and RU", () => {
    const seen = new Set<string>();
    const rows = VISIBLE_CATALOG.filter((row) => {
      if (row.uiStatus !== "editable" || row.control !== "select" || row.options.length === 0) return false;
      if (seen.has(row.storageKey)) return false;
      seen.add(row.storageKey);
      return true;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const option of row.options) {
        expect(enumLabelKnown(row.storageKey, option) || isBrandEnumValue(option)).toBe(true);
        setLocaleOverride("en");
        const english = presentEnumLabel(row.storageKey, option);
        setLocaleOverride("ru");
        const russian = presentEnumLabel(row.storageKey, option);
        expect(english.length).toBeGreaterThan(0);
        expect(russian.length).toBeGreaterThan(0);
        if (!isBrandEnumValue(option) && option !== "FTS5" && option !== "BM25" && option !== "fts5" && option !== "bm25") {
          expect(english).not.toBe(option);
          expect(english).not.toMatch(/^[a-z]+(?:_[a-z0-9]+)+$/);
        }
        if (option === "fts5") expect(english).toBe("FTS5");
        if (option === "bm25") expect(english).toBe("BM25");
      }
    }
    setLocaleOverride("en");
    expect(presentEnumLabel("adoc.040", "in_place")).toBe(en.enumWorkspaceInPlace);
    expect(presentEnumLabel("adoc.040", "worktree")).toBe(en.enumWorkspaceWorktree);
    expect(presentEnumLabel("adoc.040", "auto")).toBe(en.enumWorkspaceAuto);
    setLocaleOverride("ru");
    expect(presentEnumLabel("adoc.040", "in_place")).toBe(ru.enumWorkspaceInPlace);
    expect(presentEnumLabel("adoc.040", "worktree")).toBe(ru.enumWorkspaceWorktree);
    expect(presentEnumLabel("adoc.040", "auto")).toBe(ru.enumWorkspaceAuto);
    expect(presentEnumLabel("adoc.040", "legacy_snake")).toBe(ru.enumUnsupported);
    expect(presentEnumLabel("adoc.040", "legacy_snake")).not.toBe("legacy_snake");
    setLocaleOverride("en");
    expect(presentEnumLabel("browser_qa.provider", "jev")).toBe("jev");
    expect(presentEnumLabel("browser_qa.provider", "codex")).toBe("codex");
    expect(presentEnumLabel("ops.tail_source", "supervisor")).toBe(en.enumTailSupervisor);
    expect(rows.some((row) => row.storageKey === "ops.tail_source")).toBe(true);
    setLocaleOverride(null);
  });
});
