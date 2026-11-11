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

/**
 * `verification.ssh_keys` (project, on|off, unset = off): checks run with the owner's credential stores masked (`~/.ssh`
 * included), so a check can use the network but cannot publish. `on` leaves `~/.ssh` readable for that project's checks only.
 */
export const SETTING_SSH_KEYS = "verification.ssh_keys";
export const sshKeysOpen = (settings: Readonly<Record<string, unknown>>): boolean => switchOn(settings, SETTING_SSH_KEYS);
const SSH_REFUSED = /Permission denied \(publickey\)|Host key verification failed|Could not read from remote repository/;
/**
 * One evidence line for a failed check that ran with `~/.ssh` masked and printed an ssh refusal: the cause and the exact
 * command that lifts it. Null when the check passed, ssh was not masked, or the output shows no ssh refusal.
 */
export function sshMaskEvidence(input: { projectId: string; exitCode: number; output: string; masked: boolean | undefined }): string | null {
  if (input.exitCode === 0 || !input.masked || !SSH_REFUSED.test(input.output)) return null;
  return `lane-pilot: the check could not reach its remote over ssh because ~/.ssh is masked inside checks (publication is closed by default); to let this project's checks read the owner's ssh keys run: bb lane-pilot setting ${input.projectId} ${SETTING_SSH_KEYS}=on`;
}
