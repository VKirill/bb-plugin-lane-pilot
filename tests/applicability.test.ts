import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTING_CATALOG } from "../src/channels";
import { UI_CATALOG, VISIBLE_CATALOG } from "../src/ui-catalog";

const summary = JSON.parse(
  readFileSync(new URL("../src/ui-catalog.summary.json", import.meta.url), "utf8"),
) as { editable: number; readonly: number; gap: number; excluded: number; blank: number; tuple_equal: boolean };

const SETTINGS = JSON.parse(
  readFileSync(new URL("../../../.agency/jobs/AG-179/settings.json", import.meta.url), "utf8"),
) as { settings: Array<{ area: string; setting: string; location: string; category: string }> };

const APPLICABILITY = readFileSync(new URL("../docs/adoc-applicability.md", import.meta.url), "utf8");
const PATH_LINE = /[A-Za-z0-9_./{}*-]+:\d+/;

function parseApplicabilityTable(): Array<{
  area: string; setting: string; location: string; category: string;
  decision: string; evidence: string;
}> {
  const lines = APPLICABILITY.split("\n");
  const start = lines.findIndex((line) => line.startsWith("| # | area | setting | location | category |"));
  expect(start).toBeGreaterThanOrEqual(0);
  const rows: ReturnType<typeof parseApplicabilityTable> = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    expect(cells).toHaveLength(8);
    rows.push({
      area: cells[1]!,
      setting: cells[2]!,
      location: cells[3]!,
      category: cells[4]!,
      decision: cells[6]!,
      evidence: cells[7]!,
    });
  }
  return rows;
}

describe("adoc applicability catalog", () => {
  it("matches settings.json 1:1 on area+setting+location+category", () => {
    expect(UI_CATALOG).toHaveLength(355);
    expect(SETTINGS.settings).toHaveLength(355);
    const catalogKeys = UI_CATALOG.map((row) => `${row.area}\0${row.setting}\0${row.location}\0${row.category}`);
    const settingKeys = SETTINGS.settings.map((row) => `${row.area}\0${row.setting}\0${row.location}\0${row.category}`);
    expect(catalogKeys).toEqual(settingKeys);
  });

  it("has a decision and path:line evidence on every row and counts match", () => {
    expect(UI_CATALOG.every((row) => row.uiStatus.length > 0 && row.rationale.length > 0 && PATH_LINE.test(row.evidence))).toBe(true);
    const counts = { editable: 0, readonly: 0, gap: 0, excluded: 0 };
    for (const row of UI_CATALOG) counts[row.uiStatus] += 1;
    expect(counts).toEqual({
      editable: summary.editable,
      readonly: summary.readonly,
      gap: summary.gap,
      excluded: summary.excluded,
    });
    expect(counts.editable + counts.readonly + counts.gap + counts.excluded).toBe(355);
    expect(summary.blank).toBe(0);
    expect(summary.tuple_equal).toBe(true);
  });

  it("documents the same 355 rows in markdown with location, category, and path:line", () => {
    const rows = parseApplicabilityTable();
    expect(rows).toHaveLength(355);
    expect(rows.filter((row) => !PATH_LINE.test(row.evidence))).toEqual([]);
    for (const [index, row] of rows.entries()) {
      expect(row.area).toBe(SETTINGS.settings[index]!.area);
      expect(row.setting).toBe(SETTINGS.settings[index]!.setting);
      expect(row.location).toBe(SETTINGS.settings[index]!.location);
      expect(row.category).toBe(SETTINGS.settings[index]!.category);
      expect(row.decision.length).toBeGreaterThan(0);
    }
    const sums = { editable: 0, readonly: 0, gap: 0, excluded: 0 };
    for (const row of rows) sums[row.decision as keyof typeof sums] += 1;
    expect(sums).toEqual({
      editable: summary.editable,
      readonly: summary.readonly,
      gap: summary.gap,
      excluded: summary.excluded,
    });
  });

  it("maps every SETTING_CATALOG key onto a UI storageKey", () => {
    const stored = new Set(UI_CATALOG.map((row) => row.storageKey));
    expect(SETTING_CATALOG.map((spec) => spec.key).filter((key) => !stored.has(key))).toEqual([]);
  });

  it("keeps legacy fast-mode rows diagnostic and aliases the TUI field to service tier", () => {
    const legacy = UI_CATALOG.filter((row) => ["s024", "s303", "s315"].includes(row.id));
    expect(legacy).toHaveLength(3);
    expect(legacy.every((row) => row.storageKey === "writer.fast_mode" && row.uiStatus === "readonly" && row.channel === "NONE")).toBe(true);
    expect(UI_CATALOG.find((row) => row.id === "s142")).toMatchObject({
      storageKey: "writer.service_tier",
      uiStatus: "editable",
      channel: "W-DIRECT",
    });
  });

  it("keeps all former UI-visible fields on screen", () => {
    expect(VISIBLE_CATALOG).toHaveLength(201);
    expect(VISIBLE_CATALOG.every((row) => row.uiStatus !== "excluded")).toBe(true);
  });

  it("does not embed absolute home paths in catalog strings", () => {
    const blob = JSON.stringify(UI_CATALOG);
    expect(blob).not.toMatch(/\/home\/ubuntu/);
    expect(blob).not.toMatch(/\/Users\//);
  });
});
