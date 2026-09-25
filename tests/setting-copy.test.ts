import { describe, expect, it } from "vitest";
import { en, ru } from "../i18n";
import { SETTING_META, settingLabelIsRaw } from "../src/setting-copy";
import { VISIBLE_CATALOG } from "../src/ui-catalog";
import { estimateTokens } from "../src/stages/memory";

const PICKER_PREFIXES = [
  "writer.provider", "writer.model", "writer.reasoning_effort", "writer.service_tier",
  "memory.provider", "memory.model", "memory.reasoning_effort", "memory.service_tier",
  "night_review.provider", "night_review.model", "night_review.reasoning_effort", "night_review.service_tier",
  "docs.provider", "docs.model", "docs.reasoning_effort", "docs.service_tier",
  "onboarding.provider", "onboarding.model", "onboarding.reasoning_effort", "onboarding.service_tier",
  "pm_read.provider", "pm_read.model", "pm_read.reasoning_effort", "pm_read.service_tier",
  "plan_critique.provider", "plan_critique.model", "plan_critique.reasoning_effort", "plan_critique.service_tier",
  "code_critique.provider", "code_critique.model", "code_critique.reasoning_effort", "code_critique.service_tier",
];

function uniqueEditable() {
  const seen = new Set<string>();
  return VISIBLE_CATALOG.filter((row) => {
    if (row.uiStatus !== "editable") return false;
    if (row.storageKey.startsWith("jev.")) return false;
    if (PICKER_PREFIXES.includes(row.storageKey)) return false;
    if (row.storageKey.endsWith(".agent") && row.storageKey !== "writer.agent") return false;
    if (seen.has(row.storageKey)) return false;
    seen.add(row.storageKey);
    return true;
  });
}

describe("setting copy", () => {
  it("covers every exposed editable field with human EN/RU labels and required units", () => {
    const missing: string[] = [];
    const raw: string[] = [];
    const unitGaps: string[] = [];
    for (const row of uniqueEditable()) {
      const meta = SETTING_META[row.storageKey];
      if (!meta) {
        missing.push(row.storageKey);
        continue;
      }
      const enLabel = en[meta.label];
      const ruLabel = ru[meta.label];
      if (settingLabelIsRaw(row, enLabel) || settingLabelIsRaw(row, ruLabel)) raw.push(row.storageKey);
      if (row.storageKey.endsWith("_budget") && meta.unit !== "fieldUnitTokens") unitGaps.push(row.storageKey);
      if ((row.control === "slider" || row.invType === "int" || row.invType.includes("int")) && row.control !== "select" && row.control !== "switch" && !meta.unit) {
        if (!row.storageKey.endsWith(".enabled")) unitGaps.push(row.storageKey);
      }
    }
    expect(missing).toEqual([]);
    expect(raw).toEqual([]);
    expect(unitGaps).toEqual([]);
  });

  it("counts memory budgets as tokens matching estimateTokens", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(en.fieldUnitTokens).toBe("tokens");
    expect(ru.fieldUnitTokens).toBe("токены");
    expect(en.settingMemoryCoreBudget).not.toBe("memory.core_budget");
    expect(ru.settingMemoryCoreBudget).not.toBe("memory.core_budget");
  });
});
