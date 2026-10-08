import { PROVIDER_POOL_KEY, providerPoolProblem } from "@lane-pilot/settings-catalog";
import { SCHEDULE_ERRAND_DEFAULT_KEY, errandDefaultProblem } from "../schedule/errand-model";
import "../workflow/route-workflow";
import "@lane-pilot/jev/judgments/repair-group";
import "../runs/failure-class-judgment";
import "@lane-pilot/jev/judgments/output-guard";
import { listJudgments } from "@lane-pilot/jev";
import { jevSettingProblem } from "@lane-pilot/jev";
import { UI_CATALOG, WRITER_EFFORT_CHOICES_BY_PROVIDER } from "@lane-pilot/settings-catalog";

export type SettingValidationError = {
  code: "invalid_choice" | "incompatible_setting";
  key: string;
  params: string[];
};

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

const WORKFLOW_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function validateSettingValue(key: string, value: unknown): SettingValidationError | null {
  const minimum = key === "plan_critique.min_score" ? 0
    : key === "plan_critique.min_write_tasks" ? 1
    : key === "code_critique.max_rounds" ? 1
    : key.startsWith("run.max_") ? 1
    : key === "writer.silence_nudge_min" || key === "integration.gate_every" ? 1
    : key === "council.max_rounds" ? 1 : null;
  if (key === "code_critique.max_rounds" && value !== undefined && value !== null && value !== "") {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3) {
      return { code:"invalid_choice", key, params:[key, "integer 1-3"] };
    }
    return null;
  }
  // The efforts a workflow node may name (the `reasoning` enum of the agent node); a preset or the generic agent with another word would fail at the spawn.
  if (/^workflow\.(agent|debugger|preset\.[a-z-]+)\.reasoning_effort$/.test(key) && value !== undefined && value !== null && value !== "") {
    return typeof value === "string" && WORKFLOW_EFFORTS.includes(value) ? null : { code: "invalid_choice", key, params: [key, WORKFLOW_EFFORTS.join(", ")] };
  }
  // The owner's model override of one workflow step (`workflow.model_override.<workflowId>/<nodeId>`): a complete provider + model pair.
  if (key.startsWith("workflow.model_override.") && value !== undefined && value !== null) {
    const row = typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const effort = row?.reasoning_effort, tier = row?.service_tier;
    const ok = row && typeof row.provider === "string" && row.provider && typeof row.model === "string" && row.model
      && (effort === undefined || (typeof effort === "string" && WORKFLOW_EFFORTS.includes(effort))) && (tier === undefined || tier === "fast" || tier === "default");
    return ok ? null : { code: "invalid_choice", key, params: [key, "{provider, model, reasoning_effort?, service_tier?}"] };
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
    const problem = jevSettingProblem(key, value, listJudgments());
    return problem ? { code:"invalid_choice", key, params:[key, problem] } : null;
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
