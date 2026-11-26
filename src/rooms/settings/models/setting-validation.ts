import {
  HUB_KEYS,
  PROJECT_DEFAULT_KEYS,
  PROVIDER_POOL_KEY,
  SETTING_WRITER_SILENCE_NUDGE_MIN,
  WRITER_EFFORT_CHOICES_BY_PROVIDER,
  boundProblem,
  hubSettingProblem,
  providerPoolProblem,
} from "@lane-pilot/settings-catalog";
import { ROLE_MODEL_KEY_PREFIX, ZCODE_BACKGROUND_KEY, ZCODE_WINDOW_KEY, roleModelProblem, zcodeWindowProblem } from "@lane-pilot/models";
import { leadSettingProblem } from "../../lead";
import { SCHEDULE_ERRAND_DEFAULT_KEY, errandDefaultProblem } from "../../schedule";
import { PLANNING_HOME_SETTING, planningHomeProblem } from "../../contracts";
import { SETTINGS_REGISTRY } from "../../settings-registry";
import type { SettingValidationError } from "../../setting-validation";

export type { SettingValidationError } from "../../setting-validation";

/** Choices generated from registered select controls and shared by every consumer of a key. */
export function allowedSettingChoices(key: string): string[] | null {
  if (key.endsWith(".agent")) return null;
  const def = SETTINGS_REGISTRY.get(key);
  if (!def || def.uiStatus !== "editable" || def.control !== "select") return null;
  return def.options.length ? [...def.options] : null;
}

/** The checks whose project-level rows the self-improvement screen edits as defaults (and `memory.note_budget`, which shares range validation). */
const PROJECT_CHECK_KEYS: ReadonlySet<string> = new Set([...PROJECT_DEFAULT_KEYS, "memory.note_budget"]);

const WORKFLOW_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function validateSettingValue(key: string, value: unknown): SettingValidationError | null {
  if (key === PLANNING_HOME_SETTING && value !== undefined && value !== null && value !== "") {
    const problem = typeof value === "string" ? planningHomeProblem(value) : "the planning home must be an absolute folder path";
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  if (key.startsWith("lead.")) {
    const problem = leadSettingProblem(key, value);
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  if (HUB_KEYS.has(key) || PROJECT_CHECK_KEYS.has(key)) {
    const problem = hubSettingProblem(key, value);
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  if (key === "code_critique.max_rounds" && value !== undefined && value !== null && value !== "") {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3) {
      return { code: "invalid_choice", key, params: [key, "integer 1-3"] };
    }
    return null;
  }
  if (/^workflow\.(debugger|preset\.[a-z-]+)\.reasoning_effort$/.test(key) && value !== undefined && value !== null && value !== "") {
    return typeof value === "string" && WORKFLOW_EFFORTS.includes(value) ? null : { code: "invalid_choice", key, params: [key, WORKFLOW_EFFORTS.join(", ")] };
  }
  if (key.startsWith(ROLE_MODEL_KEY_PREFIX)) {
    const problem = roleModelProblem(key, value);
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  if (key === SCHEDULE_ERRAND_DEFAULT_KEY) {
    const problem = errandDefaultProblem(value);
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  if (key === PROVIDER_POOL_KEY) {
    const problem = providerPoolProblem(value);
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  if (key === ZCODE_WINDOW_KEY) {
    const problem = zcodeWindowProblem(value);
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  if (key === ZCODE_BACKGROUND_KEY && value !== undefined && value !== null && value !== "" && typeof value !== "boolean" && value !== "on" && value !== "off") {
    return { code: "invalid_choice", key, params: [key, "true, false, on or off"] };
  }
  if (key === "usage.skip_percent" && value !== undefined && value !== null && value !== "") {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
      return { code: "invalid_choice", key, params: [key, "integer 0-100"] };
    }
    return null;
  }
  if (key === SETTING_WRITER_SILENCE_NUDGE_MIN || key === "integration.gate_every" || key === "plan_critique.min_score" || key === "plan_critique.min_write_tasks" || key.startsWith("run.max_")) {
    if (value !== undefined && value !== null && value !== "") {
      const def = SETTINGS_REGISTRY.get(key);
      if (def) {
        const problem = boundProblem(def, value);
        return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
      }
      const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
      if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
        return { code: "invalid_choice", key, params: [key, "integer >= 1"] };
      }
    }
    return null;
  }
  const def = SETTINGS_REGISTRY.get(key);
  if (def && !key.endsWith(".agent")) {
    const problem = boundProblem(def, value);
    if (problem) return { code: "invalid_choice", key, params: [key, problem] };
  }
  return null;
}

/** Setting keys judged as one group: changing the provider can invalidate the effort and the reverse. */
const COUPLED_SETTING_KEYS: Record<string, readonly string[]> = {
  "writer.provider": ["writer.reasoning_effort"],
  "writer.reasoning_effort": ["writer.provider"],
};

export function coupledSettingKeys(key: string): readonly string[] {
  return COUPLED_SETTING_KEYS[key] ?? [];
}

/**
 * The first error a save of `changedKeys` would break: the changed keys and the keys coupled to them, judged on the
 * merged settings.
 */
export function validateSettingChanges(changedKeys: readonly string[], settings: Record<string, unknown>, skipKeys: readonly string[] = []): SettingValidationError | null {
  const relevant = new Set(changedKeys);
  for (const key of changedKeys) for (const coupled of coupledSettingKeys(key)) relevant.add(coupled);
  for (const key of skipKeys) relevant.delete(key);
  return validateSettingsObject(settings).find((error) => relevant.has(error.key)) ?? null;
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

/** The shape writer/argv-builder asks for: setting key -> why it cannot apply. */
export function argvValidationMap(settings: Record<string, unknown>): ReadonlyMap<string, string> {
  return new Map(validateSettingsObject(settings).map((error) => [error.key, validationErrorText(error)]));
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
