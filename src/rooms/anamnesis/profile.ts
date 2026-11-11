import { unsafeReason } from "./model";

/** The eight keys of a project's infra profile (SMA k_pl_infra): the `profile.<key>` project settings, written by `bb lane-pilot profile` and the start's profile writer. */
/** The settings themselves, spelled out so a search for a key finds its reader. */
export const PROFILE_SETTING_KEYS = ["profile.stack", "profile.test_command", "profile.release", "profile.hosts", "profile.start", "profile.deploy", "profile.logs", "profile.style"] as const;
export const PROFILE_KEYS = PROFILE_SETTING_KEYS.map((key) => key.slice("profile.".length)) as unknown as readonly ["stack", "test_command", "release", "hosts", "start", "deploy", "logs", "style"];
export const PROFILE_VALUE_MAX = 1000;

/** Key names of a profile that hold a secret: whole words only (api_key, apiKey, DB_PASSWORD), so `monkey` or `keyboard_layout` pass. */
export function secretKeyName(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((word) => /^(passwords?|passwd|secrets?|tokens?|credentials?|apikeys?|privatekeys?)$/.test(word))) return true;
  return words.some((word, at) => word === "key" && (words[at - 1] === "api" || words[at - 1] === "private"));
}

/**
 * Why a key/value pair may not enter the profile, or null. One filter for both writers: an unknown key (the reason lists the eight), a key
 * name that holds a secret, a value that looks like one (never quoted back), a value over 1000 characters.
 */
export function profilePairProblem(key: string, value: string): string | null {
  if (!(PROFILE_KEYS as readonly string[]).includes(key)) return `unknown profile key «${key.slice(0, 40)}»; the keys are: ${PROFILE_KEYS.join(", ")}`;
  if (secretKeyName(key) || unsafeReason(key) !== null) return "the key name looks like a secret";
  if (unsafeReason(value) !== null) return "the value looks like a secret";
  if (value.length > PROFILE_VALUE_MAX) return `the value is longer than ${PROFILE_VALUE_MAX} characters`;
  return null;
}
