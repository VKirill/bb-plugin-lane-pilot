import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { loadProjectSettings } from "../../../storage";
import type { EvolveLogSink } from "../repositories/case-repository";

export type EvolveServiceContext = {
  db: Parameters<typeof loadProjectSettings>[0];
  projectId?: string | null | undefined;
  settings?: Record<string, unknown> | undefined;
  bb?: unknown;
  log?: EvolveLogSink | ((message: string) => void) | undefined;
};

/** Normalizes logger callbacks from `ctx.log` and `ctx.bb.log` into one sink. */
export function makeLogSink(ctx: Pick<EvolveServiceContext, "log" | "bb">): Required<EvolveLogSink> {
  const sink = typeof ctx.log === "object" && ctx.log !== null ? ctx.log : undefined;
  const fn = typeof ctx.log === "function" ? ctx.log : undefined;
  const bbLog = (ctx.bb as { log?: EvolveLogSink } | undefined)?.log;
  return {
    debug: (m) => { sink?.debug?.(m); bbLog?.debug?.(m); },
    info: (m) => { sink?.info?.(m); if (fn) fn(`INFO ${m}`); else bbLog?.info?.(m); },
    warn: (m) => { sink?.warn?.(m); if (fn) fn(`WARN ${m}`); else bbLog?.warn?.(m); },
    error: (m) => { sink?.error?.(m); if (fn) fn(`ERROR ${m}`); else if (bbLog?.error) bbLog.error(m); else bbLog?.warn?.(m); },
  };
}

/** Loads persisted project/global settings and overlays explicit in-memory overrides. */
export function readMergedSettings(ctx: Pick<EvolveServiceContext, "db" | "projectId" | "settings">): Record<string, unknown> {
  let fromDb: Record<string, unknown> = {};
  try {
    fromDb = loadProjectSettings(ctx.db, ctx.projectId ?? GLOBAL_SETTINGS_PROJECT_ID);
  } catch {
    fromDb = {};
  }
  return ctx.settings ? { ...fromDb, ...ctx.settings } : fromDb;
}
