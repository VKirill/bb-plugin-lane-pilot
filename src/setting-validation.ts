import { UI_CATALOG, WRITER_EFFORT_CHOICES_BY_PROVIDER } from "./ui-catalog";

export type SettingValidationError = {
  code: "invalid_choice" | "incompatible_setting";
  key: string;
  params: string[];
};

/** Choices generated from the pinned upstream consumers and shared by every row for a storage key. */
export function allowedSettingChoices(key: string): string[] | null {
  const choices = new Set<string>();
  for (const row of UI_CATALOG) {
    if (row.storageKey !== key || row.uiStatus !== "editable" || row.control !== "select") continue;
    for (const option of row.options) choices.add(option);
  }
  return choices.size ? [...choices] : null;
}

export function validateSettingValue(key: string, value: unknown): SettingValidationError | null {
  const allowed = allowedSettingChoices(key);
  if (!allowed || value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && allowed.includes(value)) return null;
  return { code: "invalid_choice", key, params: [key, allowed.join(", ")] };
}

export function validateSettingsObject(settings: Record<string, unknown>): SettingValidationError[] {
  const errors: SettingValidationError[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const error = validateSettingValue(key, value);
    if (error) errors.push(error);
  }
  const provider = settings["writer.provider"];
  const effort = settings["writer.reasoning_effort"];
  if (typeof provider === "string" && typeof effort === "string") {
    const allowed = WRITER_EFFORT_CHOICES_BY_PROVIDER[provider];
    if (allowed && !allowed.includes(effort)) {
      errors.push({
        code: "incompatible_setting",
        key: "writer.reasoning_effort",
        params: ["writer.reasoning_effort", "writer.provider", provider, allowed.join(", ")],
      });
    }
  }
  return errors;
}

/** Keep the provider/effort group valid when its leading key changes. */
export function normalizeWriterEffort(provider: string, currentEffort: unknown): { effort: string; changed: boolean } {
  const allowed = WRITER_EFFORT_CHOICES_BY_PROVIDER[provider] ?? [];
  if (typeof currentEffort === "string" && allowed.includes(currentEffort)) {
    return { effort: currentEffort, changed: false };
  }
  const effort = allowed[0];
  return effort ? { effort, changed: effort !== currentEffort } : { effort: String(currentEffort ?? ""), changed: false };
}

export function validationErrorText(error: SettingValidationError): string {
  return error.code === "invalid_choice"
    ? `invalid value; allowed: ${error.params[1] ?? ""}`
    : `invalid value; incompatible with ${error.params[1] ?? "setting"}=${error.params[2] ?? ""}; allowed: ${error.params[3] ?? ""}`;
}

export function invalidChoiceReason(key: string, value: unknown): string | null {
  const error = validateSettingValue(key, value);
  return error ? validationErrorText(error) : null;
}
