import { z } from "zod";

/**
 * The Pixel World: the browser's way in. `world_snapshot` returns the whole world once (the static map only when asked),
 * then the screen follows the batches of the `lp-world` realtime channel or the WebSocket route (see
 * `@lane-pilot/world-sim/protocol`) and asks `world_events` for what it missed. Shapes are `WorldSnapshot` and `WorldEvent`.
 */
export const rpcWorld = {
  world_snapshot: {
    input: z.object({ withMap: z.boolean().optional(), projectId: z.string().min(1).optional() }).strict(),
    output: z.object({ snapshot: z.record(z.string(), z.unknown()), serverTime: z.number() }).strict(),
  },
  world_events: {
    input: z.object({ afterSeq: z.number().int().min(0) }).strict(),
    output: z.object({ reset: z.boolean(), events: z.array(z.unknown()), eventSeq: z.number().int(), t: z.number() }).strict(),
  },
  world_status: {
    input: z.object({}).strict(),
    output: z.object({
      enabled: z.boolean(), running: z.boolean(), broken: z.boolean(), tick: z.number(), time: z.number(), hour: z.number(), day: z.number(), citizens: z.number().int(), sites: z.number().int(),
      districts: z.number().int(), eventSeq: z.number().int(), lastTickAt: z.number().nullable(), savedAt: z.number().nullable(), stateBytes: z.number().int(), sockets: z.number().int(), watching: z.boolean(),
    }).strict(),
  },
  world_enable: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }).strict(),
  },
} as const;
