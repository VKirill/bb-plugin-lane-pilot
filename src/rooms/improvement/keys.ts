/**
 * The controls of the self-improvement flow as settings of the global level (project id `*`), one table for everything that reads or writes them.
 *
 * Before this table four of them had a store of their own (the night loop and the bench in the plugin key-value store, the owner push in
 * `lane_pilot_owner_config`, the harness per project). They are now rows of `lane_pilot_project_settings` like every other setting, saved with
 * `save_setting` and its versions. The old stores stay as the fallback: a field with no row reads what the old store holds, so nothing
 * that was set with `bb lane-pilot wall config`, `bench config` or `owner-waiting config` is lost. The CLI commands write the rows.
 */

export type HubArea = "wall" | "bench" | "owner_push" | "harness";
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

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const HUB_SPECS: readonly HubSpec[] = [
  { key: "wall.enabled", area: "wall", field: "enabled", kind: "bool" },
  { key: "wall.max_classes_per_night", area: "wall", field: "maxClassesPerNight", kind: "int", min: 1, max: 3 },
  { key: "wall.rounds_per_night", area: "wall", field: "roundsPerNight", kind: "int", min: 1, max: 2 },
  { key: "wall.walks", area: "wall", field: "walks", kind: "int", min: 1, max: 5 },
  { key: "wall.hunters", area: "wall", field: "hunters", kind: "int", min: 1, max: 5 },
  { key: "wall.night_token_cap", area: "wall", field: "nightTokenCap", kind: "int", min: 0, max: 1_000_000_000 },
  { key: "wall.hunt_share_percent", area: "wall", field: "huntShare", kind: "int", min: 1, max: 100, divisor: 100 },
  { key: "wall.assumed_repair_tokens", area: "wall", field: "assumedRepairTokens", kind: "int", min: 0, max: 1_000_000_000 },
  { key: "wall.hunter_provider", area: "wall", field: "hunterProviderId", kind: "text" },
  { key: "wall.hunter_model", area: "wall", field: "hunterModel", kind: "text" },
  { key: "wall.hunter_reasoning_effort", area: "wall", field: "hunterReasoningLevel", kind: "enum", options: EFFORTS },
  { key: "wall.bench_subset", area: "wall", field: "benchSubset", kind: "int", min: 0, max: 50 },
  { key: "wall.rerun_sandbox_only", area: "wall", field: "rerunSandboxOnly", kind: "bool" },
  { key: "wall.recurrence_floor", area: "wall", field: "recurrenceFloor", kind: "int", min: 1, max: 50 },
  { key: "bench.budget_tokens", area: "bench", field: "budgetTokens", kind: "int", min: 1, max: 10_000_000_000 },
  { key: "bench.budget_hours", area: "bench", field: "budgetHours", kind: "int", min: 1, max: 168 },
  { key: "harness.adopt_by", area: "harness", field: "adoptBy", kind: "enum", options: ["bench", "live"] },
  { key: "owner_push.enabled", area: "owner_push", field: "enabled", kind: "bool" },
  { key: "owner_push.quiet", area: "owner_push", field: "quiet", kind: "time_range" },
  { key: "owner_push.timezone", area: "owner_push", field: "timezone", kind: "time_zone" },
];

export const HUB_KEYS: ReadonlySet<string> = new Set(HUB_SPECS.map((spec) => spec.key));
export const specOf = (key: string): HubSpec | undefined => HUB_SPECS.find((spec) => spec.key === key);

/** Settings of the global level that a project may override with its own row (they are read per project). */
export const PROJECT_DEFAULT_KEYS = [
  "baseline.already_built", "baseline.time_cap_sec",
  "regress.nightly", "regress.last_n", "regress.last_days", "regress.check_cap_sec", "regress.budget_sec", "regress.bisect_steps",
] as const;

/** Whole-number bounds of the project-level checks; the readers (src/rooms/baseline/logic.ts) clamp to the same ranges. */
const PROJECT_RANGES: Record<string, { min: number; max: number; zeroOff?: boolean }> = {
  "baseline.time_cap_sec": { min: 10, max: 3600, zeroOff: true },
  "regress.last_n": { min: 1, max: 200 },
  "regress.last_days": { min: 1, max: 365 },
  "regress.check_cap_sec": { min: 5, max: 1800 },
  "regress.budget_sec": { min: 60, max: 14_400 },
  "regress.bisect_steps": { min: 1, max: 14 },
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
  if (key === "baseline.already_built") return value === "notify" || value === "stop" ? null : "notify или stop";
  if (key === "regress.nightly") return typeof value === "boolean" || ["on", "off", "true", "false"].includes(String(value)) ? null : "on, off, true, false";
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
