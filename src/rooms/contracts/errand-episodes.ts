import type { SqlDb } from "./sql-db";

export const ERRAND_EPISODE_TABLE = "lane_pilot_errand_episode";
export const ERRAND_EPISODE_EXTRACTOR_VERSION = 1;
/** Events of the helper thread the trace reads at most (the harness reader pages 100 at a time). */
export const ERRAND_EPISODE_TRACE_EVENTS = 1500;

export type ErrandOutcome = "running" | "done" | "blocked" | "failed" | "canceled";
/** What the code saw of a done (errandCheck): `unknown` for a run before CHECK lines, and for one that did not end in a report. */
export type ErrandVerifiedOutcome = "done_checked" | "done_unchecked" | "blocked" | "unknown";

/** What an errand run came to, in the owner's five words; a helper the owner stopped is «canceled», not a failure (schedule-service.ts says the same). */
export function errandOutcome(status: string, output: { state?: unknown; reason?: unknown; verified?: unknown } | null, reason: string | null): { outcome: ErrandOutcome; reason: string; verified: ErrandVerifiedOutcome } {
  const verified: ErrandVerifiedOutcome = status === "succeeded" && (output?.verified === "done_checked" || output?.verified === "done_unchecked" || output?.verified === "blocked") ? output.verified : "unknown";
  if (status === "running" || status === "waiting") return { outcome: "running", reason: "", verified };
  const why = typeof output?.reason === "string" && output.reason ? output.reason : reason ?? "";
  if (status === "canceled") return { outcome: "canceled", reason: why, verified };
  if (status === "succeeded") {
    if (output?.state === "done") return { outcome: "done", reason: "", verified };
    return /cancel/iu.test(why) ? { outcome: "canceled", reason: why, verified } : { outcome: "blocked", reason: why, verified };
  }
  return { outcome: "failed", reason: why, verified };
}

/** episodes.collect (default on): a project or the global layer may switch the recorder off; nothing is written then. */
export function collectEnabled(settings: Record<string, unknown>): boolean {
  const value = settings["episodes.collect"];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
  return true;
}

/** The errand episode recorder and its spawn read, implemented by src/rooms/errands and handed to the workflow engine. */
export interface ErrandEpisodesApi {
  recordErrandEpisode(deps: {
    db: SqlDb; runId: string;
    /** The helper thread's events, oldest first, at most ERRAND_EPISODE_TRACE_EVENTS; absent → the trace stays null. */
    readEvents?: (threadId: string) => Promise<unknown[]>;
    log?: (message: string) => void; warn?: (message: string) => void;
  }): Promise<void>;
  errandSpawnOf(db: SqlDb, runId: string): { threadId: string; browserMachine: string | null } | null;
}
