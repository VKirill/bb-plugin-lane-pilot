import { UI_CATALOG } from "./ui-catalog";

/** Choices generated from the pinned upstream consumers and shared by every row for a storage key. */
export function allowedSettingChoices(key: string): string[] | null {
  const choices = new Set<string>();
  for (const row of UI_CATALOG) {
    if (row.storageKey !== key || row.uiStatus !== "editable" || row.control !== "select") continue;
    for (const option of row.options) choices.add(option);
  }
  return choices.size ? [...choices] : null;
}

export function invalidChoiceReason(key: string, value: unknown): string | null {
  const allowed = allowedSettingChoices(key);
  if (!allowed || value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && allowed.includes(value)) return null;
  return `invalid value; allowed: ${allowed.join(", ")}`;
}
