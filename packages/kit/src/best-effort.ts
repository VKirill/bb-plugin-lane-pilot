/**
 * Named boundary for best-effort side effects (notices, metrics, cleanup, optional reads):
 * the work's failure is logged once with `label` and the caller gets `fallback`.
 * Expected absence is not an error — check it before calling (existsSync, a kv.get that
 * returns undefined, a typed-miss parse) instead of catching here. Pass `bb.log` (a
 * PluginLogger) or `ctx.log` (a plain function) as `log`.
 */
export type BestEffortLog = ((message: string) => void) | { warn(message: string): void };

const warnLine = (log: BestEffortLog, line: string): void => {
  if (typeof log === "function") log(line);
  else log.warn(line);
};

const why = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export async function bestEffort<T>(log: BestEffortLog, label: string, work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    warnLine(log, `${label}: ${why(cause)}`);
    return fallback;
  }
}
