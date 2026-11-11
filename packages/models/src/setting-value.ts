/** A setting stored as a bool, a number or a string («0», «off», «false», «no») reads as off. */
export function settingOff(value: unknown): boolean {
  return value === false || value === 0
    || (typeof value === "string" && ["0", "off", "false", "no"].includes(value.trim().toLowerCase()));
}

/**
 * What an unset on|off switch of `bb lane-pilot setting` means. One table: a reader asks `switchOn` and carries no default of
 * its own, so turning a behaviour on for everyone is one line here.
 */
export const SWITCHES_ON_BY_DEFAULT: ReadonlySet<string> = new Set(["phase.commit_docs", "hook.prompt_recall", "protection.rearm"]);

/**
 * An on|off switch as it acts: the stored word «on» or «off», else the table's default. Only the two words count, as every
 * reader had it: «true», «yes» or 1 are not «on» (the `setting` verb stores nothing else, and a hand-written row stays inert).
 */
export function switchOn(settings: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = settings[key];
  const word = typeof value === "string" ? value.trim().toLowerCase() : "";
  return word === "on" || (word !== "off" && SWITCHES_ON_BY_DEFAULT.has(key));
}

/** The on side of `settingOff`: true, 1 or «1», «true», «on», «yes». */
export function settingOn(value: unknown): boolean {
  return value === true || value === 1
    || (typeof value === "string" && ["1", "true", "on", "yes"].includes(value.trim().toLowerCase()));
}
