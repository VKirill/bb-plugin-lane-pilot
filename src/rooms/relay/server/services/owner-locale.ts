import { isOwnerLocale, type OwnerLocale } from "../../models/owner-locale";
import { readExplicitLocaleValue, readResolvedLocaleValue, writeResolvedLocaleValue, type LocaleKvReader, type LocaleKvWriter } from "../repositories/owner-locale-repository";

/** The owner's explicit ru/en choice, else the locale the UI last resolved (Auto); null when neither is known yet. */
export async function knownOwnerLocale(bb: LocaleKvReader): Promise<OwnerLocale | null> {
  const stored = await readExplicitLocaleValue(bb);
  if (isOwnerLocale(stored)) return stored;
  const resolved = await readResolvedLocaleValue(bb);
  return isOwnerLocale(resolved) ? resolved : null;
}

/**
 * The language of owner-facing forms: an explicit ru/en preference, else the last locale the UI
 * resolved (Auto), else Russian.
 */
export async function ownerLocale(bb: LocaleKvReader): Promise<OwnerLocale> {
  return (await knownOwnerLocale(bb)) ?? "ru";
}

export async function recordResolvedLocale(bb: LocaleKvWriter, locale: OwnerLocale): Promise<void> {
  await writeResolvedLocaleValue(bb, locale);
}

/** The owner's explicit ru/en choice only (what the UI stored), null when nothing was chosen. */
export async function explicitOwnerLocale(bb: LocaleKvReader): Promise<OwnerLocale | null> {
  const stored = await readExplicitLocaleValue(bb);
  return isOwnerLocale(stored) ? stored : null;
}
