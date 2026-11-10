import { PROVIDER_POOL_KEY, SETTING_WRITER_SILENCE_NUDGE_MIN, providerPoolProblem } from "@lane-pilot/settings-catalog";
import { leadSettingProblem } from "../lead";
import { ROLE_MODEL_KEY_PREFIX, ZCODE_BACKGROUND_KEY, ZCODE_WINDOW_KEY, roleModelProblem, zcodeWindowProblem } from "@lane-pilot/models";
import { SCHEDULE_ERRAND_DEFAULT_KEY, errandDefaultProblem } from "../schedule";
import { routeWorkflow, routeRecheck } from "../workflow/route-workflow";
import { repairGroup } from "@lane-pilot/jev/judgments/repair-group";
import { failureClassJudgment } from "../runs/failure-class-judgment";
import { outputGuard } from "@lane-pilot/jev/judgments/output-guard";
import { wallFilterJudgment } from "../wall";
import { listJudgments, type Judgment } from "@lane-pilot/jev";
import { jevSettingProblem } from "@lane-pilot/jev";
import { HUB_KEYS, PROJECT_DEFAULT_KEYS, hubSettingProblem } from "@lane-pilot/settings-catalog";
import { UI_CATALOG, WRITER_EFFORT_CHOICES_BY_PROVIDER } from "@lane-pilot/settings-catalog";

import type { SettingValidationError } from "../setting-validation";

export type { SettingValidationError } from "../setting-validation";

/**
 * The judgments the settings validation names explicitly, so their modules are loaded whatever else the entry point imports: the
 * registry (`listJudgments`) holds only what some module has already registered, and the list must not depend on import order.
 */
const SETTING_JUDGMENTS = [routeWorkflow, routeRecheck, repairGroup, failureClassJudgment, outputGuard, wallFilterJudgment];

function settingJudgments(): ReadonlyArray<Pick<Judgment<unknown, unknown>, "id" | "defaultMode" | "thresholds">> {
  return [...new Map([...listJudgments(), ...SETTING_JUDGMENTS].map((judgment) => [judgment.id, judgment])).values()];
}

/** Choices generated from the pinned upstream consumers and shared by every row for a storage key. */
export function allowedSettingChoices(key: string): string[] | null {
  // Agent role labels are bounded at execution time and can be host-specific.
  if (key.endsWith(".agent")) return null;
  const choices = new Set<string>();
  for (const row of UI_CATALOG) {
    if (row.storageKey !== key || row.uiStatus !== "editable" || row.control !== "select") continue;
    for (const option of row.options) choices.add(option);
  }
  return choices.size ? [...choices] : null;
}

/** The checks whose project-level rows the self-improvement screen edits as defaults (and `memory.note_budget`, which had no range check). */
const PROJECT_CHECK_KEYS: ReadonlySet<string> = new Set([...PROJECT_DEFAULT_KEYS, "memory.note_budget"]);

const WORKFLOW_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function validateSettingValue(key: string, value: unknown): SettingValidationError | null {
  // The lead's settings (src/rooms/lead/settings.ts): the switch, the home project, the zone, the daily budget, the cron, the proposals per tick.
  if (key.startsWith("lead.")) {
    const problem = leadSettingProblem(key, value);
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  // The self-improvement controls (src/rooms/improvement/keys.ts) carry their own ranges, shared with the readers and the CLI.
  if (HUB_KEYS.has(key) || PROJECT_CHECK_KEYS.has(key)) {
    const problem = hubSettingProblem(key, value);
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  const minimum = key === "plan_critique.min_score" ? 0
    : key === "plan_critique.min_write_tasks" ? 1
    : key === "code_critique.max_rounds" ? 1
    : key.startsWith("run.max_") ? 1
    : key === SETTING_WRITER_SILENCE_NUDGE_MIN || key === "integration.gate_every" ? 1
    : key === "council.max_rounds" ? 1 : null;
  if (key === "code_critique.max_rounds" && value !== undefined && value !== null && value !== "") {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3) {
      return { code:"invalid_choice", key, params:[key, "integer 1-3"] };
    }
    return null;
  }
  // The efforts a preset or the debugger's old selection may name; another word would fail at the spawn.
  if (/^workflow\.(debugger|preset\.[a-z-]+)\.reasoning_effort$/.test(key) && value !== undefined && value !== null && value !== "") {
    return typeof value === "string" && WORKFLOW_EFFORTS.includes(value) ? null : { code: "invalid_choice", key, params: [key, WORKFLOW_EFFORTS.join(", ")] };
  }
  // The table «role -> model» (`role_model.<role>`): one of the Claude / GPT models of the table and an effort.
  if (key.startsWith(ROLE_MODEL_KEY_PREFIX)) {
    const problem = roleModelProblem(key, value);
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  // The default model of scheduled errands: a complete provider + model pair, or a preset.
  if (key === SCHEDULE_ERRAND_DEFAULT_KEY) {
    const problem = errandDefaultProblem(value);
    return problem ? { code: "invalid_choice", key, params: [key, problem] } : null;
  }
  if (key === PROVIDER_POOL_KEY) {
    const problem = providerPoolProblem(value);
    return problem ? { code:"invalid_choice", key, params:[key, problem] } : null;
  }
  if (key === "jev.thresholds" || key === "jev.modes") {
    const problem = jevSettingProblem(key, value, settingJudgments());
    return problem ? { code:"invalid_choice", key, params:[key, problem] } : null;
  }
  // When the ZCode app may be used: only in its free hours (promo, the default) or at any hour (always).
  if (key === ZCODE_WINDOW_KEY) {
    const problem = zcodeWindowProblem(value);
    return problem ? { code:"invalid_choice", key, params:[key, problem] } : null;
  }
  // Whether the background rows try ZCode's free tokens first in its hours (on by default).
  if (key === ZCODE_BACKGROUND_KEY && value !== undefined && value !== null && value !== "" && typeof value !== "boolean" && value !== "on" && value !== "off") {
    return { code:"invalid_choice", key, params:[key, "true, false, on or off"] };
  }
  if (key === "usage.skip_percent" && value !== undefined && value !== null && value !== "") {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
      return { code:"invalid_choice", key, params:[key, "integer 0-100"] };
    }
    return null;
  }
  if (minimum !== null && value !== undefined && value !== null && value !== "") {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) {
      return { code:"invalid_choice", key, params:[key, `integer >= ${minimum}`] };
    }
    return null;
  }
  const allowed = allowedSettingChoices(key);
  if (!allowed || value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && allowed.includes(value)) return null;
  // UI switches send booleans for true/false settings; every consumer parses both forms.
  if (typeof value === "boolean" && allowed.includes(String(value))) return null;
  return { code: "invalid_choice", key, params: [key, allowed.join(", ")] };
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
 * merged settings. `skipKeys` are keys the caller already validated itself (a role selection RPC checks its group
 * against the live provider catalog); an unrelated stored value that an older catalog no longer lists must not refuse
 * the save either.
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

/** The shape writer/argv-builder asks for: setting key → why it cannot apply. */
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
