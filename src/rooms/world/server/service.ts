import {
  WORLD_CHANNEL, WORLD_STREAM_PATH, applyLanePilotSignal, catchUp, createWorld, hashString, hourOf, dayOf, snapshot, step,
  type LanePilotSignal, type WorldBatch, type WorldClientMessage, type WorldEvent, type WorldServerMessage, type WorldSnapshot, type WorldState,
} from "@lane-pilot/world-sim";
import { onAttemptChanged, type LanePilotDatabase } from "../../storage";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createSignalSource } from "./signals";
import { loadWorld, saveWorld } from "./store";

/**
 * The tick service of the Pixel World. One world per hub: its districts are the projects, so a council or a self-repair
 * shows in the same city whatever project it belongs to, and a viewer sees every project at once (the snapshot can be
 * filtered to one). The service owns the clock (real time, 1 sim second per second), turns Lane Pilot's run data into
 * signals, saves the world to the plugin database and delivers sim events to browsers in batches.
 */

export type WorldServiceOptions = {
  /** How often the loop wakes up. The world itself steps in fixed 1 s sim steps; 2 Hz keeps events fresh. */
  tickMs?: number;
  /** Events are cut into a batch at most this often (two batches a second). */
  flushMs?: number;
  saveMs?: number;
  pollMs?: number;
  /** Real time that is simulated after a stop, at most (the world is a day older at most). */
  maxCatchUpMs?: number;
  /** Sim seconds per real second. */
  speed?: number;
  citizens?: number;
  /** Sim seconds in a game hour for a new world (a saved world keeps its own). */
  hourSeconds?: number;
  seed?: number;
  now?: () => number;
  /** Looks up a project's name for the sign of its district. */
  projectName?: (projectId: string) => Promise<string | null>;
};

const DEFAULTS = { tickMs: 500, flushMs: 500, saveMs: 30_000, pollMs: 5_000, maxCatchUpMs: 24 * 3_600_000, speed: 1, citizens: 24 };
/** How long a browser that called an RPC counts as watching (realtime batches are published only then). */
const VIEWER_TTL_MS = 90_000;
const RING_MAX = 4000;
const REPLAY_MAX = 1500;
/** A tick after a stall longer than this runs as a coarse catch-up instead of one step. */
const STALL_SECONDS = 5;
const MAX_FAILURES = 10;

type RealtimeHost = { realtime?: { publish?: (channel: string, payload: unknown) => void } };
type EventsHost = { events?: { on?: (event: string, handler: (payload: unknown) => unknown) => void } };

export type WorldStatus = {
  running: boolean;
  broken: boolean;
  tick: number;
  time: number;
  hour: number;
  day: number;
  citizens: number;
  sites: number;
  districts: number;
  eventSeq: number;
  lastTickAt: number | null;
  savedAt: number | null;
  stateBytes: number;
  sockets: number;
  watching: boolean;
};

const valueAt = (value: unknown, key: string): unknown => (value && typeof value === "object" ? Reflect.get(value, key) : undefined);
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function createWorldService(ctx: { bb: BbPluginApi; db: LanePilotDatabase; log: (message: string) => void; isDisposed: () => boolean }, options: WorldServiceOptions = {}) {
  const { bb, db } = ctx;
  const cfg = { ...DEFAULTS, ...options };
  const now = cfg.now ?? Date.now;
  const source = createSignalSource({ db, now });
  const sockets = new Set<{ send: (data: string) => void; close: (code?: number) => void }>();
  const dirty = new Set<string>();
  const repairs = new Set<string>();
  const ring: WorldEvent[] = [];
  let out: WorldEvent[] = [];
  let world: WorldState | null = null;
  let lastTickAt = 0;
  let lastPoll = 0;
  let lastFlush = 0;
  let lastSave = 0;
  let savedAt: number | null = null;
  let stateBytes = 0;
  let viewerAt = 0;
  let failures = 0;
  let running = false;
  const named = new Set<string>();

  const touch = () => { viewerAt = now(); };
  const watching = () => sockets.size > 0 || now() - viewerAt < VIEWER_TTL_MS;

  function save(): void {
    if (!world || ctx.isDisposed()) return;
    try { stateBytes = saveWorld(db, world, lastTickAt, now()); savedAt = now(); lastSave = savedAt; }
    catch (cause) { if (!ctx.isDisposed()) ctx.log(`world: save failed: ${errorText(cause)}`); }
  }

  function record(events: WorldEvent[]): void {
    if (!events.length) return;
    out.push(...events);
    ring.push(...events);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  }

  function ingest(signal: LanePilotSignal): void {
    if (!world) return;
    const result = applyLanePilotSignal(world, signal);
    record(result.events);
    const applied = result.events.find((e) => e.type === "signal");
    if (applied && applied.type === "signal" && !applied.applied) ctx.log(`world: signal ${signal.type} not applied: ${applied.note ?? "?"}`);
    // The district's sign needs the project's name, which only BB knows; the signal repeats with it once found.
    if (signal.type === "project_upserted" && !signal.name && cfg.projectName && !named.has(signal.projectId)) {
      named.add(signal.projectId);
      void cfg.projectName(signal.projectId).then((name) => { if (name && world && !ctx.isDisposed()) ingest({ ...signal, name }); }, () => undefined);
    }
  }

  function flush(force = false): void {
    const t = now();
    if (!out.length || (!force && t - lastFlush < cfg.flushMs)) return;
    lastFlush = t;
    const events = out;
    out = [];
    const w = world!;
    const batch: WorldBatch = { kind: "world", t: w.time, hour: hourOf(w), day: dayOf(w), firstSeq: events[0]!.seq, lastSeq: events[events.length - 1]!.seq, events };
    const text = JSON.stringify(batch);
    for (const socket of sockets) { try { socket.send(text); } catch { sockets.delete(socket); } }
    // BB sends a plugin signal to every connected client, so it goes out only while someone is looking.
    if (now() - viewerAt < VIEWER_TTL_MS) {
      try { (bb as unknown as RealtimeHost).realtime?.publish?.(WORLD_CHANNEL, batch); }
      catch (cause) { if (!ctx.isDisposed()) ctx.log(`world: realtime publish failed: ${errorText(cause)}`); }
    }
  }

  /** One wake-up of the loop at wall-clock time `at` (the loop's timer, or a test). */
  function tickAt(at: number): void {
    if (!world) return;
    const dt = Math.max(0, (at - lastTickAt) / 1000) * cfg.speed;
    lastTickAt = at;
    try {
      if (dt > STALL_SECONDS) catchUp(world, dt, 5);
      else record(step(world, dt).events);
      if (dirty.size || at - lastPoll >= cfg.pollMs) {
        lastPoll = at;
        const ids = [...dirty];
        dirty.clear();
        for (const signal of source.poll(ids)) ingest(signal);
      }
      failures = 0;
    } catch (cause) {
      failures++;
      ctx.log(`world: tick failed (${failures}/${MAX_FAILURES}): ${errorText(cause)}`);
    }
    flush();
    if (at - lastSave >= cfg.saveMs) save();
  }

  /** Loads the saved world (or makes a new one), brings it up to date and tells the signal source what it already knows. */
  function boot(at: number): void {
    let loaded: ReturnType<typeof loadWorld> = null;
    try { loaded = loadWorld(db); } catch (cause) { ctx.log(`world: the saved world could not be read, starting a new one: ${errorText(cause)}`); }
    if (loaded) {
      world = loaded.world;
      const elapsed = Math.min(Math.max(0, at - loaded.tickAt), cfg.maxCatchUpMs) / 1000 * cfg.speed;
      if (elapsed > 1) { catchUp(world, elapsed, 30); ctx.log(`world: caught up ${Math.round(elapsed)} sim seconds after the stop`); }
    } else {
      world = createWorld(cfg.seed ?? hashString("lane-pilot-world"), { citizens: cfg.citizens, ...(cfg.hourSeconds ? { hourSeconds: cfg.hourSeconds } : {}) });
      ctx.log("world: created a new world");
    }
    lastTickAt = at; lastPoll = 0; lastFlush = at; lastSave = at;
    source.seed({ attempts: Object.keys(world.attempts), projects: Object.keys(world.projects), councils: Object.keys(world.meetings).map((id) => id.slice(2)) });
    record([]);
    save();
  }

  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
    timer.unref?.();
  });

  async function loop(signal: AbortSignal): Promise<void> {
    running = true;
    try {
      boot(now());
      while (!signal.aborted && !ctx.isDisposed() && failures < MAX_FAILURES) {
        await sleep(cfg.tickMs, signal);
        if (signal.aborted || ctx.isDisposed()) break;
        tickAt(now());
      }
      if (failures >= MAX_FAILURES) {
        ctx.log("world: stopped after repeated tick failures; the next reload starts it again");
        // Resolving would look like a clean end to BB; wait for the stop instead.
        await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      }
    } finally {
      running = false;
      flush(true);
      save();
    }
  }

  // ---- delivery ----

  function filtered(full: WorldSnapshot, projectId?: string): WorldSnapshot {
    if (!projectId) return full;
    const districtId = world!.projects[projectId];
    const district = districtId ? full.districts[districtId] : undefined;
    const keep = (districtId: string | null) => districtId === null || districtId === district?.id;
    return {
      ...full,
      districts: district ? { [district.id]: district } : {},
      sites: Object.fromEntries(Object.entries(full.sites).filter(([, s]) => s.projectId === projectId)),
      buildings: Object.fromEntries(Object.entries(full.buildings).filter(([, b]) => keep(b.districtId))),
    };
  }

  function currentSnapshot(input: { withMap?: boolean; projectId?: string } = {}): WorldSnapshot {
    if (!world) throw new Error("The world is not running yet");
    touch();
    return filtered(snapshot(world, { withMap: input.withMap === true }), input.projectId);
  }

  function eventsAfter(afterSeq: number): { reset: boolean; events: WorldEvent[]; eventSeq: number; t: number } {
    touch();
    const w = world;
    if (!w) return { reset: true, events: [], eventSeq: 0, t: 0 };
    flush(true);
    const first = ring[0]?.seq;
    // Events the ring no longer holds, or a client from the future (the world was recreated): the client takes a new snapshot.
    if (afterSeq > w.eventSeq || (first !== undefined && afterSeq < first - 1) || (first === undefined && afterSeq < w.eventSeq)) {
      return { reset: true, events: [], eventSeq: w.eventSeq, t: w.time };
    }
    return { reset: false, events: ring.filter((e) => e.seq > afterSeq).slice(0, REPLAY_MAX), eventSeq: w.eventSeq, t: w.time };
  }

  function status(): WorldStatus {
    const w = world;
    return {
      running, broken: failures >= MAX_FAILURES, tick: w?.tick ?? 0, time: w?.time ?? 0, hour: w ? hourOf(w) : 0, day: w ? dayOf(w) : 0,
      citizens: w ? Object.keys(w.citizens).length : 0, sites: w ? Object.keys(w.sites).length : 0, districts: w ? Object.keys(w.districts).length : 0,
      eventSeq: w?.eventSeq ?? 0, lastTickAt: lastTickAt || null, savedAt, stateBytes, sockets: sockets.size, watching: watching(),
    };
  }

  // ---- mounting ----

  function mountSocket(): void {
    if (typeof (bb.http as Partial<BbPluginApi["http"]> | undefined)?.experimental_websocket !== "function") return;
    bb.http.experimental_websocket(WORLD_STREAM_PATH, () => {
      let handle: { send: (data: string) => void; close: (code?: number) => void } | null = null;
      const send = (message: WorldServerMessage) => handle?.send(JSON.stringify(message));
      return {
        onOpen(socket) {
          handle = { send: (data) => socket.send(data), close: (code) => socket.close(code) };
          sockets.add(handle);
          touch();
          send({ type: "hello", eventSeq: world?.eventSeq ?? 0, t: world?.time ?? 0 });
        },
        onMessage(_socket, data) {
          let message: Partial<WorldClientMessage> | null = null;
          try { message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Partial<WorldClientMessage>; } catch { return; }
          if (message?.type !== "resume" || typeof message.afterSeq !== "number") return;
          const replay = eventsAfter(message.afterSeq);
          if (replay.reset) { send({ type: "reset", reason: "events are no longer held; fetch a snapshot" }); return; }
          for (let i = 0; i < replay.events.length; i += 200) {
            const chunk = replay.events.slice(i, i + 200);
            send({ kind: "world", t: replay.t, hour: world ? hourOf(world) : 0, day: world ? dayOf(world) : 0, firstSeq: chunk[0]!.seq, lastSeq: chunk[chunk.length - 1]!.seq, events: chunk });
          }
        },
        onClose() { if (handle) sockets.delete(handle); handle = null; },
        onError() { if (handle) sockets.delete(handle); handle = null; },
      };
    });
  }

  function mountThreadEvents(): void {
    const events = (bb as unknown as EventsHost).events;
    if (typeof events?.on !== "function") return;
    const listen = (name: string, handler: (thread: unknown) => void) => {
      try { events.on!(name, (payload) => { if (!ctx.isDisposed()) { try { handler(valueAt(payload, "thread")); } catch (cause) { ctx.log(`world: ${name} handler failed: ${errorText(cause)}`); } } }); }
      catch { /* an older BB does not know every event */ }
    };
    const isRepair = (thread: unknown) => {
      const meta = valueAt(thread, "pluginMetadata");
      const pluginId = (bb as unknown as { pluginId?: string }).pluginId ?? "lane-pilot";
      const role = valueAt(meta, "role") ?? valueAt(valueAt(meta, pluginId), "role");
      const title = valueAt(thread, "title");
      return role === "self-repair" || (typeof title === "string" && /^Lane Pilot self-repair/i.test(title));
    };
    listen("thread.created", (thread) => {
      const id = valueAt(thread, "id");
      if (typeof id !== "string" || !isRepair(thread) || repairs.has(id)) return;
      repairs.add(id);
      const projectId = valueAt(thread, "projectId");
      ingest({ type: "self_repair_started", id, ...(typeof projectId === "string" ? { projectId } : {}) });
    });
    for (const name of ["thread.idle", "thread.failed", "thread.archived", "thread.deleted"]) {
      listen(name, (thread) => {
        const id = valueAt(thread, "id");
        if (typeof id !== "string" || !repairs.delete(id)) return;
        ingest({ type: "self_repair_ended", id });
      });
    }
  }

  /** Registers the loop, the socket and the listeners; the world starts when BB starts the service. */
  function mount(): void {
    bb.onDispose(onAttemptChanged((attemptId) => { dirty.add(attemptId); }));
    mountThreadEvents();
    mountSocket();
    bb.background.service("world-tick", { start: loop });
    bb.onDispose(() => {
      for (const socket of sockets) { try { socket.close(1001); } catch { /* gone */ } }
      sockets.clear();
      flush(true);
      save();
    });
  }

  return { mount, snapshot: currentSnapshot, eventsAfter, status, ingest, tickAt, boot, save, flush, source, world: () => world };
}

export type WorldApi = ReturnType<typeof createWorldService>;
