/** A call slower than this also reports the size of its answer (stringifying every answer would cost more than it tells). */
const SIZE_REPORT_MS = 250;

type Handler = (input: never, ...rest: never[]) => unknown;

/**
 * Wraps every RPC handler so the plugin log (debug level) shows how long each call took: `rpc get_screen 38 ms` and, for a
 * slow one, `rpc get_screen 4510 ms 85.1 MB`. The page's slowness used to be measurable only from outside (curl, a browser).
 * The answer and any error pass through untouched. A call the owner gate kept out logs `refused`, not `failed`: it is the
 * gate working, and the self-repair watcher reads `failed` as a fault of Lane Pilot.
 */
export function timeRpcHandlers<T extends Record<string, Handler>>(handlers: T, log: (message: string) => void, now: () => number = () => performance.now()): T {
  const timed: Record<string, Handler> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    timed[name] = (async (input: never, ...rest: never[]) => {
      const started = now();
      let failed = false;
      let refused = false;
      let answer: unknown;
      try {
        answer = await handler(input, ...rest);
        return answer;
      } catch (cause) {
        failed = true;
        refused = (cause as { refused?: unknown } | null)?.refused === true;
        throw cause;
      } finally {
        const ms = Math.round(now() - started);
        let size = "";
        if (!failed && ms >= SIZE_REPORT_MS) {
          try {
            const bytes = JSON.stringify(answer)?.length ?? 0;
            size = bytes >= 100_000 ? ` ${(bytes / 1e6).toFixed(1)} MB` : ` ${Math.round(bytes / 1024)} KB`;
          } catch { /* an answer that cannot be stringified has no size to report */ }
        }
        try { log(`rpc ${name} ${ms} ms${refused ? " refused" : failed ? " failed" : ""}${size}`); } catch { /* logging never changes an answer */ }
      }
    }) as Handler;
  }
  return timed as T;
}
