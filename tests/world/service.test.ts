import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { createCouncilSession, setCouncilState, type CouncilSeat } from "@lane-pilot/council";
import { WORLD_CHANNEL, createWorld, parseWorldBatch, step, type WorldBatch, type WorldServerMessage } from "@lane-pilot/world-sim";
import { describe, expect, it } from "vitest";
import { rpcWorld } from "../../src/rooms/contracts/rpc-world";
import { createAttempt, createRun, createTask, openDatabase, saveStageReceipt, transitionAttempt } from "../../src/rooms/storage";
import { createWorldService, worldRpc, type WorldServiceOptions } from "../../src/rooms/world/server";
import { loadWorld, saveWorld } from "../../src/rooms/world/server/store";

/** The database stamps attempts with the real clock, so the fake one starts there. */
const T0 = Date.now();

function setup(options: WorldServiceOptions = {}) {
  const host = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(host.bb);
  const logs: string[] = [];
  let t = T0;
  const service = createWorldService({ bb: host.bb, db, log: (m) => logs.push(m), isDisposed: () => false }, { now: () => t, citizens: 24, flushMs: 0, pollMs: 1000, saveMs: 10_000, ...options });
  const advance = (ms: number) => { t += ms; service.tickAt(t); };
  return { host, db, service, logs, advance, clock: () => t, setClock: (v: number) => { t = v; } };
}

function seedRun(db: ReturnType<typeof openDatabase>, projectId = "proj1") {
  createRun(db, "run1", projectId);
  createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: { objective: "Build the login page" } });
  createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
}

const receipt = (stageId: "verification" | "code-critique", state: "running" | "passed" | "failed", updatedAt: number) => ({
  runId: "run1", taskId: "T1", stageId, contractVersion: 1 as const, state, inputSha256: "0".repeat(64), outputSha256: null, attempt: 0, providerId: null, model: null, threadId: null, result: null, reason: null, updatedAt,
});

describe("world service: load, tick, persist, catch up, dispose", () => {
  it("starts a new world, ticks in real time and saves it on a timer", () => {
    const { service, db, advance, clock } = setup();
    service.mount();
    service.boot(clock());
    expect(loadWorld(db)?.world.tick).toBe(0);
    for (let i = 0; i < 24; i++) advance(500);
    expect(service.status()).toMatchObject({ tick: 12, time: 12, citizens: 24 });
    // Saved at boot and again once the save interval passed.
    expect(loadWorld(db)?.world.tick).toBeGreaterThanOrEqual(10);
    expect(loadWorld(db)!.tickAt).toBeGreaterThan(T0);
  });

  it("catches a saved world up after a stop, capped by maxCatchUpMs", () => {
    const first = setup();
    const w = createWorld(3, { citizens: 24 });
    saveWorld(first.db, w, T0 - 3_600_000, T0 - 3_600_000);
    first.service.boot(T0);
    expect(first.service.world()!.time).toBeCloseTo(3600, 0);
    expect(first.logs.some((l) => /caught up 3600/.test(l))).toBe(true);

    const capped = setup({ maxCatchUpMs: 600_000 });
    saveWorld(capped.db, createWorld(3, { citizens: 24 }), T0 - 3_600_000, T0);
    capped.service.boot(T0);
    expect(capped.service.world()!.time).toBeCloseTo(600, 0);
  });

  it("a stall in the loop is stepped as a coarse catch-up, not one huge step", () => {
    const { service, advance, clock } = setup();
    service.boot(clock());
    advance(10 * 60_000);
    expect(service.status().time).toBeCloseTo(600, 0);
  });

  it("saves on dispose, so the next load has the world as it stood", async () => {
    const { host, service, advance, clock, logs } = setup({ saveMs: 3_600_000 });
    service.mount();
    service.boot(clock());
    for (let i = 0; i < 40; i++) advance(500);
    expect(service.world()!.time).toBe(20);
    let savedTime = -1;
    await host.harness.lifecycle.reload(async () => undefined).then((next) => { savedTime = loadWorld(openDatabase(next.bb))?.world.time ?? -1; });
    expect(savedTime).toBe(20);
    expect(logs).toEqual(["world: created a new world"]);
  });

  it("an older tick never overwrites a newer save (a reload may overlap two instances)", () => {
    const { db } = setup();
    const newer = createWorld(1, { citizens: 4 });
    step(newer, 50);
    saveWorld(db, newer, T0 + 2000, T0 + 2000);
    const older = createWorld(1, { citizens: 4 });
    step(older, 10);
    saveWorld(db, older, T0 + 1000, T0 + 3000);
    expect(loadWorld(db)!.world.time).toBe(50);
    expect(loadWorld(db)!.tickAt).toBe(T0 + 2000);
  });

  it("runs as a background service and saves when it stops", async () => {
    const { host, service, db } = setup({ tickMs: 5, speed: 400, now: Date.now });
    service.mount();
    const { controller, done } = host.harness.behavior.runService("world-tick");
    const deadline = Date.now() + 3000;
    while (service.status().tick < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(service.status().running).toBe(true);
    controller.abort();
    await done;
    expect(service.status().running).toBe(false);
    expect(loadWorld(db)!.world.tick).toBeGreaterThanOrEqual(2);
  });
});

describe("world service: Lane Pilot signals", () => {
  it("a new attempt becomes a district and a site, progress moves the target, a failed one collapses it", () => {
    const { service, db, advance, clock } = setup();
    service.mount();
    service.boot(clock());
    seedRun(db);
    advance(500);
    const w = service.world()!;
    expect(Object.values(w.districts).map((d) => d.projectId)).toEqual(["proj1"]);
    const site = Object.values(w.sites)[0]!;
    expect(site).toMatchObject({ projectId: "proj1", taskId: "T1", name: "Build the login page", target: 0 });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    advance(10 * 60_000);
    expect(site.target).toBe(2);
    transitionAttempt(db, "a1", "validation_failed", { reason: "red check" });
    advance(1000);
    expect(site.collapsed).toBe(true);
  });

  it("verification receipts send the inspector and acceptance opens the building", () => {
    const { service, db, advance, clock } = setup();
    service.mount();
    service.boot(clock());
    seedRun(db);
    advance(500);
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    advance(1000);
    saveStageReceipt(db, receipt("verification", "running", clock() + 1));
    advance(1500);
    const w = service.world()!;
    const inspector = Object.values(w.citizens).find((c) => c.role === "inspector")!;
    expect(Object.values(w.sites)[0]!.target).toBeGreaterThanOrEqual(5);
    expect(inspector.jobId ?? Object.values(w.jobs).find((j) => j.kind === "inspect")?.id).toBeTruthy();
    saveStageReceipt(db, receipt("verification", "passed", clock() + 2));
    transitionAttempt(db, "a1", "accepted");
    advance(1500);
    const site = Object.values(w.sites)[0]!;
    expect(site).toMatchObject({ approved: true, target: 6, rush: true });
  });

  it("does not announce again what a saved world already knows", () => {
    const first = setup();
    first.service.mount();
    first.service.boot(first.clock());
    seedRun(first.db);
    first.advance(500);
    const saved = first.service.world()!;
    const before = Object.keys(saved.sites).length;
    first.service.save();
    const second = setup();
    saveWorld(second.db, saved, first.clock(), first.clock());
    seedRun(second.db);
    second.service.boot(first.clock());
    second.setClock(first.clock());
    second.service.tickAt(first.clock() + 500);
    expect(Object.keys(second.service.world()!.sites)).toHaveLength(before);
    expect(Object.keys(second.service.world()!.districts)).toHaveLength(1);
  });

  it("a council in progress is a meeting in the office until it ends", () => {
    const { service, db, advance, clock } = setup();
    service.mount();
    service.boot(clock());
    createRun(db, "run1", "proj1");
    const seats = ["product", "demand", "skeptic", "chair"].map((id) => ({ id, role: id, title: id, instruction: "", providerId: null, model: null })) as unknown as CouncilSeat[];
    createCouncilSession(db, { id: "co1", projectId: "proj1", runId: "run1", question: "Q", seats, maxRounds: 3, now: clock() });
    advance(500);
    advance(6000);
    const w = service.world()!;
    expect(Object.keys(w.meetings)).toEqual(["m:co1"]);
    setCouncilState(db, "co1", { state: "done" }, clock());
    advance(6000);
    expect(Object.keys(w.meetings)).toEqual([]);
  });

  it("a self-repair thread sends the van and its end calls it back", async () => {
    const { host, service, advance, clock } = setup();
    service.mount();
    service.boot(clock());
    await host.harness.behavior.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_fix", title: "Lane Pilot self-repair: stale handle", projectId: "lp" }) });
    const w = service.world()!;
    expect(Object.values(w.vehicles).filter((v) => v.kind === "van")).toHaveLength(1);
    advance(500);
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_fix", projectId: "lp" }), lastAssistantText: "fixed" });
    for (let i = 0; i < 300; i++) advance(1000);
    const vans = () => Object.values(w.vehicles).filter((v) => v.kind === "van");
    expect(vans()).toHaveLength(0);
    // Other threads do nothing.
    await host.harness.behavior.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_other", title: "Hello" }) });
    expect(vans()).toHaveLength(0);
  });
});

describe("world service: delivery to browsers", () => {
  it("publishes batches on the realtime channel only while someone watches, in order and without gaps", () => {
    const { host, service, advance, clock } = setup();
    service.mount();
    service.boot(clock());
    for (let i = 0; i < 30; i++) advance(500);
    expect(host.harness.realtimeSignals).toHaveLength(0);
    service.snapshot();
    for (let i = 0; i < 400; i++) advance(500);
    const batches = host.harness.realtimeSignals.filter((s) => s.channel === WORLD_CHANNEL).map((s) => parseWorldBatch(s.payload)!);
    expect(batches.length).toBeGreaterThan(3);
    for (const b of batches) {
      expect(b.events.map((e) => e.seq)).toEqual(Array.from({ length: b.lastSeq - b.firstSeq + 1 }, (_, i) => b.firstSeq + i));
    }
    for (let i = 1; i < batches.length; i++) expect(batches[i]!.firstSeq).toBe(batches[i - 1]!.lastSeq + 1);
    // Batches are cut at most every flushMs (here 0, so per tick), and carry the clock.
    expect(batches[0]!.hour).toBeGreaterThanOrEqual(6);
  });

  it("serves the snapshot and the missed events over RPC, and asks for a new snapshot when events are gone", async () => {
    const { host, service, advance, clock } = setup();
    service.mount();
    service.boot(clock());
    host.bb.rpc.register(defineRpcContract(rpcWorld), worldRpc(service));
    for (let i = 0; i < 200; i++) advance(500);
    const { snapshot, serverTime } = await host.harness.behavior.callRpc("world_snapshot", { withMap: true }) as { snapshot: { map?: { sidewalk: { nodes: unknown[] } }; eventSeq: number; citizens: Record<string, unknown> }; serverTime: number };
    expect(serverTime).toBeGreaterThan(0);
    expect(snapshot.map!.sidewalk.nodes.length).toBeGreaterThan(100);
    expect(Object.keys(snapshot.citizens)).toHaveLength(24);
    const slim = await host.harness.behavior.callRpc("world_snapshot", {}) as { snapshot: { map?: unknown } };
    expect(slim.snapshot.map).toBeUndefined();
    for (let i = 0; i < 100; i++) advance(500);
    const missed = await host.harness.behavior.callRpc("world_events", { afterSeq: snapshot.eventSeq }) as { reset: boolean; events: Array<{ seq: number }> };
    expect(missed.reset).toBe(false);
    expect(missed.events[0]!.seq).toBe(snapshot.eventSeq + 1);
    const future = await host.harness.behavior.callRpc("world_events", { afterSeq: 10_000_000 }) as { reset: boolean };
    expect(future.reset).toBe(true);
    const status = await host.harness.behavior.callRpc("world_status", {}) as { running: boolean; citizens: number };
    expect(status.citizens).toBe(24);
  });

  it("filters the snapshot to one project's district and sites", async () => {
    const { service, db, advance, clock } = setup();
    service.mount();
    service.boot(clock());
    seedRun(db, "proj1");
    createRun(db, "run2", "proj2");
    createTask(db, { id: "T2", runId: "run2", kind: "bb", contract: {} });
    createAttempt(db, { id: "a2", runId: "run2", taskId: "T2" });
    advance(500);
    const all = service.snapshot();
    expect(Object.keys(all.districts)).toHaveLength(2);
    const one = service.snapshot({ projectId: "proj2" });
    expect(Object.values(one.districts).map((d) => d.projectId)).toEqual(["proj2"]);
    expect(Object.values(one.sites).map((s) => s.taskId)).toEqual(["T2"]);
    expect(Object.keys(one.buildings).length).toBeLessThan(Object.keys(all.buildings).length + 1);
  });

  it("streams over the WebSocket route: hello, live batches, resume and reset", async () => {
    const { host, service, advance, clock } = setup();
    service.mount();
    service.boot(clock());
    for (let i = 0; i < 100; i++) advance(500);
    const seq = service.status().eventSeq;
    const socket = await host.harness.behavior.experimental_openWebSocket("/world/stream");
    const received = () => socket.sent.map((m) => JSON.parse(String(m)) as WorldServerMessage);
    expect(received()[0]).toMatchObject({ type: "hello", eventSeq: seq });
    expect(service.status().sockets).toBe(1);
    for (let i = 0; i < 200; i++) advance(500);
    const live = received().filter((m): m is WorldBatch => "kind" in m);
    expect(live.length).toBeGreaterThan(0);
    expect(live[0]!.firstSeq).toBe(seq + 1);
    const before = socket.sent.length;
    await socket.receive(JSON.stringify({ type: "resume", afterSeq: seq }));
    expect(socket.sent.length).toBeGreaterThan(before);
    await socket.receive(JSON.stringify({ type: "resume", afterSeq: 99_999_999 }));
    expect(received().at(-1)).toMatchObject({ type: "reset" });
    await socket.close();
    expect(service.status().sockets).toBe(0);
  });
});

describe("world service: robustness", () => {
  it("keeps going when the signal source throws and stops after repeated failures", () => {
    const { service, logs, advance, clock } = setup({ pollMs: 0 });
    service.boot(clock());
    (service.source as unknown as { poll: () => never }).poll = () => { throw new Error("db gone"); };
    advance(500);
    expect(logs.some((l) => /tick failed \(1\/10\)/.test(l))).toBe(true);
    for (let i = 0; i < 12; i++) advance(500);
    expect(service.status().broken).toBe(true);
  });

  it("the same seed gives the same first world", () => {
    const a = setup(), b = setup();
    a.service.boot(a.clock()); b.service.boot(b.clock());
    expect(Object.keys(a.service.world()!.citizens)).toEqual(Object.keys(b.service.world()!.citizens));
    step(a.service.world()!, 100); step(b.service.world()!, 100);
    expect(JSON.stringify(a.service.world()!.citizens)).toBe(JSON.stringify(b.service.world()!.citizens));
  });
});
