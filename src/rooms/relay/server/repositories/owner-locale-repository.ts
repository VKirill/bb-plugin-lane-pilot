import { OWNER_LOCALE_PREFERENCE_KEY, OWNER_RESOLVED_LOCALE_KEY } from "../../models/owner-locale";

export type LocaleKvReader = { storage: { kv: { get: (key: string) => Promise<unknown> } } };
export type LocaleKvWriter = { storage: { kv: { set: (key: string, value: string) => Promise<unknown> } } };

export async function readExplicitLocaleValue(bb: LocaleKvReader): Promise<unknown> {
  return bb.storage.kv.get(OWNER_LOCALE_PREFERENCE_KEY);
}

export async function readResolvedLocaleValue(bb: LocaleKvReader): Promise<unknown> {
  return bb.storage.kv.get(OWNER_RESOLVED_LOCALE_KEY);
}

export async function writeResolvedLocaleValue(bb: LocaleKvWriter, locale: string): Promise<void> {
  await bb.storage.kv.set(OWNER_RESOLVED_LOCALE_KEY, locale);
}
