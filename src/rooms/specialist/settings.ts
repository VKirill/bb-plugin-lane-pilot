import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const SPECIALIST_SNAPSHOT_BYTES_KEY = "specialist.snapshot_bytes";
export const SPECIALIST_PAUSED_ALL_KEY = "specialist.paused_all";
export const DEFAULT_SPECIALIST_SNAPSHOT_BYTES = 24_000;
export const MIN_SPECIALIST_SNAPSHOT_BYTES = 8_000;
export const MAX_SPECIALIST_SNAPSHOT_BYTES = 96_000;

/** Parses `specialist.snapshot_bytes` within `[8000, 96000]`, falling back to `fallback` (default 24000). */
export function parseSpecialistSnapshotBytes(value: unknown, fallback = DEFAULT_SPECIALIST_SNAPSHOT_BYTES): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) return fallback;
  if (parsed < MIN_SPECIALIST_SNAPSHOT_BYTES) return MIN_SPECIALIST_SNAPSHOT_BYTES;
  if (parsed > MAX_SPECIALIST_SNAPSHOT_BYTES) return MAX_SPECIALIST_SNAPSHOT_BYTES;
  return parsed;
}

export const specialistSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"specialist.agent","room":"specialist","default":"specialist-reviewer","bounds":{"kind":"string"},"ui":{"id":"s096","status":"editable","control":"input","section":"specialist","scope":"project","invType":"str"}}),
  defineSetting({"key":"specialist.enabled","room":"specialist","default":false,"bounds":{"kind":"boolean","options":["true","false"]},"ui":{"id":"s091","status":"editable","control":"select","section":"other","scope":"project","options":["true","false"],"invType":"bool"}}),
  defineSetting({"key":"specialist.model","room":"specialist","default":"","bounds":{"kind":"string"},"ui":{"id":"s094","status":"editable","control":"input","section":"other","scope":"project","invType":"str"}}),
  defineSetting({"key":"specialist.provider","room":"specialist","default":"codex","bounds":{"kind":"enum","options":[],"strictOptions":false},"ui":{"id":"s093","status":"editable","control":"select","section":"other","scope":"project","invType":"enum"}}),
  defineSetting({"key":"specialist.reasoning_effort","room":"specialist","default":"high","bounds":{"kind":"string"},"ui":{"id":"s095","status":"editable","control":"input","section":"other","scope":"project","invType":"str"}}),
  defineSetting({"key":"specialist.when","room":"specialist","default":"high_risk","bounds":{"kind":"enum","options":["high_risk","always"],"strictOptions":true},"ui":{"id":"s092","status":"editable","control":"select","section":"other","scope":"project","options":["high_risk","always"],"invType":"enum"}}),
  defineSetting({"key":"specialist.service_tier","room":"specialist","default":"","defaultValue":"","bounds":{"kind":"enum","options":["standard","fast"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Specialist service tier selection"}}),
  defineSetting({
    key: SPECIALIST_SNAPSHOT_BYTES_KEY,
    room: "specialist",
    default: DEFAULT_SPECIALIST_SNAPSHOT_BYTES,
    bounds: { kind: "int", min: MIN_SPECIALIST_SNAPSHOT_BYTES, max: MAX_SPECIALIST_SNAPSHOT_BYTES },
    ui: {
      status: "hidden",
      control: "number",
      section: "specialist",
      scope: "project",
      min: MIN_SPECIALIST_SNAPSHOT_BYTES,
      max: MAX_SPECIALIST_SNAPSHOT_BYTES,
      invType: "int",
      reason: "Maximum serialized JSON byte cap for a specialist shift snapshot (8000-96000)",
    },
  }),
];
