import type { Judgment, JudgmentMode, Thresholds } from "./registry";

/**
 * Project settings of the Jev layer, each one string so that adding a judgment adds no setting row:
 *  - `jev.thresholds`: lines or comma-separated `judgment.name=value` pairs (`route.workflow.min_p=0.7`); a value outside the
 *    judgment's range is clamped, an unknown key is ignored (and reported by `thresholdsProblem` when saved).
 *  - `jev.modes`: `judgment=off|shadow|active` pairs; a judgment not listed runs in its default mode.
 *  - `jev.enabled`: false turns every judgment off for the project.
 */
export const JEV_ENABLED_KEY = "jev.enabled";
export const JEV_THRESHOLDS_KEY = "jev.thresholds";
export const JEV_MODES_KEY = "jev.modes";
export const MODES = ["off", "shadow", "active"] as const;

export type JevSettings = Record<string, unknown>;

function pairs(value: unknown): Array<[string, string]> {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, item]) => [key.trim(), String(item).trim()]);
  return String(value).split(/[\n,;]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf("=");
    return at < 0 ? [part, ""] as [string, string] : [part.slice(0, at).trim(), part.slice(at + 1).trim()] as [string, string];
  });
}

export function jevEnabled(settings: JevSettings | undefined): boolean {
  const value = settings?.[JEV_ENABLED_KEY];
  return !(value === false || value === "false" || value === "0" || value === "off");
}

/** The thresholds of one judgment: the registry defaults, then the project's values clamped to the allowed range. */
export function resolveThresholds(judgment: Pick<Judgment<unknown, unknown>, "id" | "thresholds">, settings: JevSettings | undefined): Thresholds {
  const out: Thresholds = Object.fromEntries(Object.entries(judgment.thresholds).map(([name, spec]) => [name, spec.default]));
  for (const [key, raw] of pairs(settings?.[JEV_THRESHOLDS_KEY])) {
    if (!key.startsWith(`${judgment.id}.`)) continue;
    const name = key.slice(judgment.id.length + 1), spec = judgment.thresholds[name], value = Number(raw);
    if (spec && raw !== "" && Number.isFinite(value)) out[name] = Math.min(spec.max, Math.max(spec.min, value));
  }
  return out;
}

export function resolveMode(judgment: Pick<Judgment<unknown, unknown>, "id" | "defaultMode">, settings: JevSettings | undefined): JudgmentMode {
  if (!jevEnabled(settings)) return "off";
  for (const [key, raw] of pairs(settings?.[JEV_MODES_KEY])) if (key === judgment.id && (MODES as readonly string[]).includes(raw)) return raw as JudgmentMode;
  return judgment.defaultMode;
}

/** A readable problem with a saved `jev.thresholds` or `jev.modes` value, or null: names must be known, numbers in range. */
export function jevSettingProblem(key: string, value: unknown, known: ReadonlyArray<Pick<Judgment<unknown, unknown>, "id" | "defaultMode" | "thresholds">>): string | null {
  if (key !== JEV_THRESHOLDS_KEY && key !== JEV_MODES_KEY) return null;
  for (const [name, raw] of pairs(value)) {
    if (key === JEV_MODES_KEY) {
      if (!known.some((judgment) => judgment.id === name)) return `unknown judgment "${name}"`;
      if (!(MODES as readonly string[]).includes(raw)) return `${name}: mode is off, shadow or active`;
      continue;
    }
    const judgment = known.find((item) => name.startsWith(`${item.id}.`)), spec = judgment?.thresholds[name.slice((judgment?.id.length ?? 0) + 1)];
    if (!judgment || !spec) return `unknown threshold "${name}"`;
    const number = Number(raw);
    if (raw === "" || !Number.isFinite(number)) return `${name}: a number from ${spec.min} to ${spec.max}`;
    if (number < spec.min || number > spec.max) return `${name}: from ${spec.min} to ${spec.max}`;
  }
  return null;
}
