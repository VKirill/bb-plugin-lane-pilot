/**
 * The cron of a schedule trigger: the five fields BB automations take (minute hour day-of-month month day-of-week), checked here
 * so a workflow with a broken schedule is told so when it is saved, not when the automation is refused. Names (`mon`, `jan`) and
 * the `?`, `L`, `W` forms are not accepted; a schedule written with them is a warning, never a silent no-op.
 */
const LIMITS: ReadonlyArray<readonly [string, number, number]> = [["minute", 0, 59], ["hour", 0, 23], ["day of month", 1, 31], ["month", 1, 12], ["day of week", 0, 7]];

export function cronProblem(cron: string): string | null {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== LIMITS.length) return "a cron needs exactly 5 fields: minute hour day-of-month month day-of-week";
  for (const [index, field] of fields.entries()) {
    const [name, min, max] = LIMITS[index]!;
    for (const part of field.split(",")) {
      const found = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u);
      if (!found) return `the ${name} field "${part}" is not valid`;
      const [, range = "", step] = found;
      if (step !== undefined && Number(step) < 1) return `the ${name} step in "${part}" must be at least 1`;
      if (range === "*") continue;
      const [low, high = low] = range.split("-").map(Number) as [number, number?];
      if (low < min || (high ?? low) > max || (high ?? low) < low) return `the ${name} field "${part}" must be between ${min} and ${max}`;
    }
  }
  return null;
}

export function timezoneProblem(timezone: string): string | null {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return null; } catch { return `"${timezone}" is not a time zone (use an IANA name such as Europe/Moscow)`; }
}

/** The zone of the machine the hub runs on: what a schedule without its own zone means. */
export const localTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
