import type { SettingDefinition, SettingKeyFamily } from "@lane-pilot/settings-catalog";

export const scheduleSettings: readonly SettingDefinition[] = [];

export const scheduleKeyFamilies: readonly SettingKeyFamily[] = [
  { room: "schedule", prefix: "schedule.errand_default", pattern: /^schedule\.errand_default$/, what: "Default model selection for scheduled errands" },
];
