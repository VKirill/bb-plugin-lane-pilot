// What the hub and a browser agree on (import from "@lane-pilot/world-sim/protocol"; no simulation code is pulled in).
import type { WorldEvent } from "./types";

export { positionAt } from "./plan-math";
export type { PlanePose } from "./plan-math";
export type * from "./types";

/** Realtime channel (one world per hub, so no project in the name). BB sends every plugin signal to every client. */
export const WORLD_CHANNEL = "lp-world";
/** The WebSocket route: `/api/v1/plugins/lane-pilot/http/world/stream`. */
export const WORLD_STREAM_PATH = "/world/stream";

/** Sim events grouped for delivery: at most two batches a second, in `seq` order, with no gaps inside a batch. */
export type WorldBatch = {
  kind: "world";
  /** Sim seconds at the moment the batch was cut, and the game hour and day then. */
  t: number;
  hour: number;
  day: number;
  firstSeq: number;
  lastSeq: number;
  events: WorldEvent[];
};

/** Messages over the WebSocket. The client sends `resume` after connecting (and `snapshot.eventSeq` as `afterSeq`). */
export type WorldClientMessage = { type: "resume"; afterSeq: number };
export type WorldServerMessage = { type: "hello"; eventSeq: number; t: number } | { type: "reset"; reason: string } | WorldBatch;

export function parseWorldBatch(payload: unknown): WorldBatch | null {
  if (!payload || typeof payload !== "object") return null;
  const b = payload as Partial<WorldBatch>;
  if (b.kind !== "world" || !Array.isArray(b.events) || typeof b.firstSeq !== "number" || typeof b.lastSeq !== "number" || typeof b.t !== "number") return null;
  return b as WorldBatch;
}
