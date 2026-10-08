import { PRESET_SLUGS, presetSelection, presetSlug } from "@lane-pilot/models";

/**
 * Which model a scheduled errand runs on. ONE pure function answers it for the executor (what is spawned) and for the board (what the
 * card says), so the two cannot drift. The first level that offers a model is the base; the task's own `reasoning` and `serviceTier`
 * then override the effort and the tier of that base:
 *
 *  1. the task's own pair: `providerId` + `model`; `model` alone is the legacy form and means provider claude-code;
 *  2. the task's `preset` (a model preset name: `workflow.preset.<slug>.*` in Settings, else the built-in preset);
 *  3. the Automation default (`schedule.errand_default` of the project, else of the global level): a pair or a preset;
 *  4. the errand role default: `errand.provider` / `errand.model` / `errand.reasoning_effort` when set, else the built-in default
 *     (claude-code, claude-opus-5-5, high), which is what every errand ran on before;
 *  5. the model of the project's PM chat, used only when level 4 has no model. The built-in default always has one, so today this
 *     level cannot be reached from a caller; it stays as the last resort for a build that ships no built-in (`builtin: null`).
 */
export const SCHEDULE_ERRAND_DEFAULT_KEY = "schedule.errand_default";
export const ERRAND_BUILTIN = { providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high" } as const;
export const ERRAND_ROLE_KEYS = { provider: "errand.provider", model: "errand.model", effort: "errand.reasoning_effort" } as const;
/** The efforts the native picker can answer with, and what the errand spawn takes. */
export const ERRAND_EFFORTS = ["low", "medium", "high", "xhigh", "ultracode", "max"] as const;
const LEVELS: ReadonlySet<string> = new Set(["none", ...ERRAND_EFFORTS, "ultra"]);

export type ErrandServiceTier = "default" | "fast";
export type ErrandDefaultValue = { provider: string; model: string; reasoning_effort?: string; service_tier?: ErrandServiceTier } | { preset: string };

export type ErrandModelTask = { model?: string | undefined; providerId?: string | undefined; reasoning?: string | undefined; serviceTier?: ErrandServiceTier | undefined; preset?: string | undefined };
export type ErrandModelSource = "task" | "preset" | "schedule-default" | "errand-role" | "pm";
export type ResolvedErrandModel = {
  providerId: string; model: string; reasoningEffort: string; serviceTier: ErrandServiceTier | null;
  source: ErrandModelSource;
  /** The preset slug, or the setting key the value comes from; null for the task's own fields, the built-in default and the PM. */
  sourceKey: string | null;
  issues: string[];
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Why a stored `schedule.errand_default` is not a valid value, or null. Empty (undefined, null, "") is valid: no default. */
export function errandDefaultProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const shape = "{provider, model, reasoning_effort?, service_tier?} or {preset}";
  if (typeof value !== "object" || Array.isArray(value)) return shape;
  const row = value as Record<string, unknown>;
  if ("preset" in row) {
    return Object.keys(row).length === 1 && typeof row.preset === "string" && presetSlug(row.preset) ? null : `preset: one of ${PRESET_SLUGS.join(", ")}`;
  }
  const effort = row.reasoning_effort, tier = row.service_tier;
  const ok = text(row.provider) && text(row.model)
    && (effort === undefined || (typeof effort === "string" && (ERRAND_EFFORTS as readonly string[]).includes(effort)))
    && (tier === undefined || tier === "fast" || tier === "default")
    && Object.keys(row).every((key) => ["provider", "model", "reasoning_effort", "service_tier"].includes(key));
  return ok ? null : shape;
}

/** The stored value when it is valid, else null. */
export function parseErrandDefault(raw: unknown): ErrandDefaultValue | null {
  if (raw === undefined || raw === null || raw === "" || errandDefaultProblem(raw)) return null;
  const row = raw as Record<string, unknown>;
  if ("preset" in row) return { preset: presetSlug(row.preset as string)! };
  return {
    provider: text(row.provider)!, model: text(row.model)!,
    ...(row.reasoning_effort ? { reasoning_effort: row.reasoning_effort as string } : {}), ...(row.service_tier ? { service_tier: row.service_tier as ErrandServiceTier } : {}),
  };
}

type Level = { providerId: string; model: string; effort: string | null; tier: ErrandServiceTier | null; source: ErrandModelSource; sourceKey: string | null };

export function resolveErrandModel(input: {
  task: ErrandModelTask; settings: Record<string, unknown>; pm: { providerId: string; model: string } | null;
  /** The built-in role default; `null` models a build without one (then the PM's model is the last resort). */
  builtin?: typeof ERRAND_BUILTIN | null;
}): ResolvedErrandModel {
  const { task, settings } = input;
  const builtin = input.builtin === undefined ? ERRAND_BUILTIN : input.builtin;
  const issues: string[] = [];
  let level: Level | null = null;
  const fromPreset = (name: string, source: "preset" | "schedule-default", key: string | null): Level | null => {
    const slug = presetSlug(name);
    const picked = slug ? presetSelection(slug, settings) : null;
    return picked ? { providerId: picked.providerId, model: picked.model, effort: picked.reasoning, tier: null, source, sourceKey: key ?? slug } : null;
  };

  const model = text(task.model), providerId = text(task.providerId);
  if (model) level = { providerId: providerId ?? ERRAND_BUILTIN.providerId, model, effort: null, tier: null, source: "task", sourceKey: null };
  else if (providerId) issues.push("provider_without_model");

  if (!level && text(task.preset)) {
    level = fromPreset(task.preset!, "preset", null);
    if (!level) issues.push("unknown_preset");
  }

  const stored = settings[SCHEDULE_ERRAND_DEFAULT_KEY];
  if (!level && stored !== undefined && stored !== null && stored !== "") {
    const parsed = parseErrandDefault(stored);
    if (!parsed) issues.push("invalid_schedule_default");
    else if ("preset" in parsed) level = fromPreset(parsed.preset, "schedule-default", SCHEDULE_ERRAND_DEFAULT_KEY);
    else level = { providerId: parsed.provider, model: parsed.model, effort: parsed.reasoning_effort ?? null, tier: parsed.service_tier ?? null, source: "schedule-default", sourceKey: SCHEDULE_ERRAND_DEFAULT_KEY };
  }

  if (!level) {
    const roleProvider = text(settings[ERRAND_ROLE_KEYS.provider]), roleModel = text(settings[ERRAND_ROLE_KEYS.model]);
    if (roleModel) level = { providerId: roleProvider ?? ERRAND_BUILTIN.providerId, model: roleModel, effort: text(settings[ERRAND_ROLE_KEYS.effort]), tier: null, source: "errand-role", sourceKey: ERRAND_ROLE_KEYS.model };
    else {
      if (roleProvider) issues.push("provider_without_model");
      if (builtin) level = { providerId: builtin.providerId, model: builtin.model, effort: text(settings[ERRAND_ROLE_KEYS.effort]) ?? builtin.reasoningEffort, tier: null, source: "errand-role", sourceKey: null };
    }
  }

  if (!level && input.pm) level = { providerId: input.pm.providerId, model: input.pm.model, effort: null, tier: null, source: "pm", sourceKey: null };
  if (!level) {
    issues.push("no_model");
    level = { providerId: ERRAND_BUILTIN.providerId, model: ERRAND_BUILTIN.model, effort: ERRAND_BUILTIN.reasoningEffort, tier: null, source: "errand-role", sourceKey: null };
  }

  const own = text(task.reasoning);
  const wanted = own ?? level.effort;
  // No effort anywhere: claude-code's errand default; another provider takes none rather than a level it may not offer.
  const reasoningEffort = wanted && LEVELS.has(wanted) ? wanted : level.providerId === ERRAND_BUILTIN.providerId ? ERRAND_BUILTIN.reasoningEffort : "none";
  return { providerId: level.providerId, model: level.model, reasoningEffort, serviceTier: task.serviceTier ?? level.tier, source: level.source, sourceKey: level.sourceKey, issues };
}
