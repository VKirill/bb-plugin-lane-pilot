/**
 * The controls of the self-improvement flow as settings of the global level (project id `*`), one table for everything that reads or writes them.
 *
 * Before this table four of them had a store of their own (the night loop and the bench in the plugin key-value store, the owner push in
 * `lane_pilot_owner_config`, the harness per project). They are now rows of `lane_pilot_project_settings` like every other setting, saved with
 * `save_setting` and its versions. The old stores stay as the fallback: a field with no row reads what the old store holds, so nothing
 * that was set with `bb lane-pilot wall config`, `bench config` or `owner-waiting config` is lost. The CLI commands write the rows.
 */

export type HubArea = "owner_push";
export type HubKind = "bool" | "int" | "text" | "enum" | "time_range" | "time_zone";

export type HubSpec = {
  key: string;
  area: HubArea;
  /** The field of the area's old config object this setting stands for. */
  field: string;
  kind: HubKind;
  min?: number;
  max?: number;
  options?: readonly string[];
  /** The setting holds `value`, the old field holds `value / divisor` (hunt share: percent -> fraction). */
  divisor?: number;
};

export const HUB_SPECS: readonly HubSpec[] = [
  { key: "owner_push.enabled", area: "owner_push", field: "enabled", kind: "bool" },
  { key: "owner_push.quiet", area: "owner_push", field: "quiet", kind: "time_range" },
  { key: "owner_push.timezone", area: "owner_push", field: "timezone", kind: "time_zone" },
];

export const HUB_KEYS: ReadonlySet<string> = new Set(HUB_SPECS.map((spec) => spec.key));
export const specOf = (key: string): HubSpec | undefined => HUB_SPECS.find((spec) => spec.key === key);

/** Settings of the global level that a project may override with its own row (they are read per project). */
export const PROJECT_DEFAULT_KEYS = [
  "baseline.already_built", "baseline.time_cap_sec", "checks.require_red_on_base",
] as const;

/** Whole-number bounds of the project-level checks; the readers (src/rooms/baseline/logic.ts) clamp to the same ranges. */
const PROJECT_RANGES: Record<string, { min: number; max: number; zeroOff?: boolean }> = {
  "baseline.time_cap_sec": { min: 10, max: 3600, zeroOff: true },
  "memory.note_budget": { min: 1, max: 1_000_000 },
};

export const QUIET_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: zone }); return true; } catch { return false; }
}

const whole = (value: unknown): number | null => {
  const parsed = typeof value === "string" && /^\s*-?\d+\s*$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) ? parsed : null;
};

/** Why a value is refused, in the words the owner sees next to the field; null when it is fine (and for an empty value, which means «not set»). */
export function hubSettingProblem(key: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const spec = specOf(key);
  if (spec) {
    switch (spec.kind) {
      case "bool": return typeof value === "boolean" || value === "true" || value === "false" ? null : "true, false";
      case "int": {
        const n = whole(value);
        return n !== null && n >= (spec.min ?? 0) && n <= (spec.max ?? Number.MAX_SAFE_INTEGER) ? null : `${spec.min ?? 0}-${spec.max}`;
      }
      case "enum": return typeof value === "string" && (spec.options ?? []).includes(value) ? null : (spec.options ?? []).join(", ");
      case "text": return typeof value === "string" && value.trim().length > 0 && value.length <= 120 ? null : "1-120";
      case "time_range": return typeof value === "string" && QUIET_PATTERN.test(value) ? null : "HH:MM-HH:MM (23:00-08:00)";
      case "time_zone": return typeof value === "string" && validTimeZone(value) ? null : "Europe/Madrid";
    }
  }
  const range = PROJECT_RANGES[key];
  if (range) {
    const n = whole(value);
    if (n !== null && ((range.zeroOff && n === 0) || (n >= range.min && n <= range.max))) return null;
    return range.zeroOff ? `0, ${range.min}-${range.max}` : `${range.min}-${range.max}`;
  }
  if (key === "checks.require_red_on_base") return value === "off" || value === "medium" || value === "high" ? null : "off, medium, high";
  if (key === "baseline.already_built") return value === "notify" || value === "stop" ? null : "notify или stop";
  return null;
}

/** The value of a field as the old config object holds it. */
export function fieldValue(spec: HubSpec, value: unknown): unknown {
  if (spec.kind === "bool") return value === true || value === "true" || value === "on";
  if (spec.kind === "int") {
    const n = whole(value);
    return n === null ? undefined : spec.divisor ? n / spec.divisor : n;
  }
  return value;
}

/** The setting value for a field of the old config object (the inverse of `fieldValue`). */
export function settingValue(spec: HubSpec, field: unknown): unknown {
  if (spec.kind === "int" && typeof field === "number") return spec.divisor ? Math.round(field * spec.divisor) : field;
  return field;
}
