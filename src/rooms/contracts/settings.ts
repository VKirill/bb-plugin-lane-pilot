import { VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";

/** A setting by its catalog name, whether stored under that name or under its storage key. */
export function configuredSetting(settings: Record<string, unknown>, setting: string): unknown {
  if (Object.hasOwn(settings, setting)) return settings[setting];
  const row = VISIBLE_CATALOG.find((item) => item.setting === setting);
  return row ? settings[row.storageKey] : undefined;
}
