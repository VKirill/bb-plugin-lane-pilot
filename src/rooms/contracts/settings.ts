import { LEGACY_SETTING_ALIASES } from "@lane-pilot/settings-catalog";

/** A setting by its catalog name, whether stored under that name or under its storage key. */
export function configuredSetting(settings: Record<string, unknown>, setting: string): unknown {
  if (Object.hasOwn(settings, setting)) return settings[setting];
  const canonical = LEGACY_SETTING_ALIASES[setting];
  return canonical ? settings[canonical] : undefined;
}
