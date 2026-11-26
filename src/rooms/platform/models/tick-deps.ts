/**
 * Tick wiring (SMA m_tick_deps): the services keys the scheduleIsolated bodies and the startup
 * recovery read by name. They are wired once at start and can be inspected, so a missing piece is
 * found at start, not at the tick.
 */
export const TICK_DEPS = [
  "stability",
  "schedules",
  "workflowTriggers",
  "workflowEngine",
  "canary",
  "providerBreaker",
  "startWriterTask",
  "resumeOrphans",
  "startAfterAcceptance",
  "resumeBrowserQaThreads",
] as const;

export type TickDepsReport = { wired: string[]; missing: string[] };

export function checkTickDeps(services: Record<string, unknown>): TickDepsReport {
  const missing = TICK_DEPS.filter((name) => services[name] === undefined || services[name] === null);
  return { wired: TICK_DEPS.filter((name) => !missing.includes(name)).map(String), missing: [...missing] };
}
