/** A setting stored as a bool, a number or a string («0», «off», «false», «no») reads as off. */
export function settingOff(value: unknown): boolean {
  return value === false || value === 0
    || (typeof value === "string" && ["0", "off", "false", "no"].includes(value.trim().toLowerCase()));
}

/** The on side of `settingOff`: true, 1 or «1», «true», «on», «yes». */
export function settingOn(value: unknown): boolean {
  return value === true || value === 1
    || (typeof value === "string" && ["1", "true", "on", "yes"].includes(value.trim().toLowerCase()));
}
