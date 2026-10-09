import { describe, expect, it } from "vitest";
import { decide } from "../src/ai";
import { hasEdge } from "../src/graph";
import { generateMap } from "../src/map";
import { applyLanePilotSignal, catchUp, cloneState, createWorld, hourOf, listScenarios, parseScenario, parseWorld, positionAt, serializeWorld, snapshot, step, targetForPercent, type Graph, type LanePilotSignal, type Plan, type Vec, type WorldEvent, type WorldState } from "../src";
import { shortestPath } from "../src/graph";

const run = (s: WorldState, seconds: number, onEvents?: (events: WorldEvent[]) => void) => {
  for (let i = 0; i < seconds; i++) { const r = step(s, 1); if (onEvents && r.events.length) onEvents(r.events); }
};
const signal = (s: WorldState, sig: LanePilotSignal) => applyLanePilotSignal(s, sig);
const stagesOf = (events: WorldEvent[], siteId?: string) => events.filter((e): e is Extract<WorldEvent, { type: "stage" }> => e.type === "stage" && (!siteId || e.siteId === siteId)).map((e) => e.stage);

describe("map", () => {
  const map = generateMap();
  it("reserves the office lot at the centre and connects every plot to it", () => {
    const office = map.plots[map.officePlotId]!;
    expect([office.x0, office.x1, office.z0, office.z1]).toEqual([-20, 20, -10, 10]);
    for (const plot of Object.values(map.plots)) {
      expect(shortestPath(map.sidewalk, office.doorNode, plot.doorNode), plot.id).not.toBeNull();
      expect(shortestPath(map.road, map.plots[map.depotPlotId]!.roadNode, plot.roadNode), plot.id).not.toBeNull();
      for (const slot of plot.slots) expect(shortestPath(map.sidewalk, plot.doorNode, slot.node)).not.toBeNull();
    }
    expect(map.grid.tiles).toHaveLength(map.grid.w * map.grid.d);
  });
});

describe("determinism and serialisation", () => {
  it("same seed and steps give the same state, another seed does not", () => {
    const a = createWorld(11), b = createWorld(11), c = createWorld(12);
    run(a, 900); run(b, 900); run(c, 900);
    expect(serializeWorld(a)).toBe(serializeWorld(b));
    expect(serializeWorld(a)).not.toBe(serializeWorld(c));
  });

  it("a saved world loads and continues exactly like the original", () => {
    const a = createWorld(5, { citizens: 40 });
    run(a, 600);
    const b = parseWorld(serializeWorld(a));
    expect(b.map).toEqual(a.map);
    run(a, 600); run(b, 600);
    expect(serializeWorld(b)).toBe(serializeWorld(a));
    expect(serializeWorld(cloneState(a))).toBe(serializeWorld(a));
    expect(() => parseWorld(JSON.stringify({ schema: 99 }))).toThrow(/schema/);
  });
});

describe("citizens", () => {
  const quiet = () => createWorld(3, { citizens: 12, scenarios: [], startHour: 12 });
  const choose = (s: WorldState, id: string) => { const c = s.citizens[id]!; c.plan = null; const sim = { s, events: [] as WorldEvent[] }; decide(sim, c); return c.plan!; };

  it("lose needs over time and recover them by acting", () => {
    const s = quiet();
    const c = s.citizens.c1!;
    const before = { ...c.needs };
    run(s, 120 * 2);
    expect(c.needs.hunger).toBeLessThan(before.hunger + 0.01);
    expect(Object.values(c.needs).every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it("picks what the strongest need asks for", () => {
    const s = quiet();
    const everyone = Object.values(s.citizens);
    const hungry = everyone.find((c) => c.workId === null || c.role === "resident") ?? everyone[0]!;
    hungry.needs = { energy: 0.9, hunger: 0.02, social: 0.9, fun: 0.9, work: 0.9 };
    expect(choose(s, hungry.id).action).toBe("eat");
    const worn = everyone[1]!;
    s.time = 10 * 120; // 22:00
    worn.needs = { energy: 0.02, hunger: 0.9, social: 0.9, fun: 0.9, work: 0.9 };
    expect(hourOf(s)).toBeGreaterThan(21);
    expect(["sleep", "rest"]).toContain(choose(s, worn.id).action);
    const bored = everyone[2]!;
    s.time = 0;
    bored.needs = { energy: 0.9, hunger: 0.9, social: 0.9, fun: 0.01, work: 0.99 };
    bored.workId = null; bored.deskPoi = null;
    expect(["park", "shop"]).toContain(choose(s, bored.id).action);
  });

  it("never sends a citizen without a workplace to work", () => {
    const s = createWorld(9, { citizens: 30, scenarios: [] });
    const jobless = Object.values(s.citizens).filter((c) => !c.workId).map((c) => c.id);
    expect(jobless.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    run(s, 4 * 120 * 6, (events) => events.forEach((e) => { if (e.type === "plan" && jobless.includes(e.plan.actorId)) seen.add(e.plan.action); }));
    expect(seen.has("work")).toBe(false);
    expect(seen.size).toBeGreaterThan(2);
  });

  it("goes to work in the morning under the commute scenario and sleeps at night", () => {
    const s = createWorld(4, { citizens: 40 });
    const workers = Object.values(s.citizens).filter((c) => c.workId);
    run(s, 120 * 3.5); // 06:00 to 09:30
    const working = workers.filter((c) => c.plan && ["work", "build", "repair"].includes(c.plan.action)).length;
    expect(working / workers.length).toBeGreaterThan(0.7);
    run(s, 120 * 17); // 02:30
    expect(hourOf(s)).toBeGreaterThan(1);
    const asleep = Object.values(s.citizens).filter((c) => c.plan?.action === "sleep").length;
    expect(asleep / 40).toBeGreaterThan(0.8);
  });
});

describe("plans", () => {
  const onGraph = (graph: Graph, path: Vec[]) => {
    const nodeAt = new Map(graph.nodes.map((n) => [`${n.x},${n.z}`, n.id]));
    const ids = path.map((p) => nodeAt.get(`${p.x},${p.z}`));
    // The first point may be where a walk in progress was taken over; it must lie on an edge then.
    const start = ids[0] === undefined ? 1 : 0;
    if (start === 1) {
      const p = path[0]!;
      const onEdge = graph.edges.some((e) => {
        const a = graph.nodes[e.a]!, b = graph.nodes[e.b]!;
        const cross = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
        const within = Math.min(a.x, b.x) - 1e-6 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-6 && Math.min(a.z, b.z) - 1e-6 <= p.z && p.z <= Math.max(a.z, b.z) + 1e-6;
        return Math.abs(cross) < 1e-6 * e.len && within;
      });
      if (!onEdge) return false;
    }
    for (let i = Math.max(start, 1); i < ids.length; i++) {
      const a = ids[i - 1], b = ids[i];
      if (b === undefined) return false;
      if (a !== undefined && a !== b && !hasEdge(graph, a, b)) return false;
    }
    return true;
  };

  it("keep people on the sidewalk graph and vehicles on the road graph", () => {
    const s = createWorld(21, { citizens: 40, startHour: 8 });
    signal(s, { type: "task_dispatched", projectId: "p1", taskId: "T1", attemptId: "a1" });
    signal(s, { type: "attempt_progress", attemptId: "a1", percent: 0.6 });
    let people = 0, cars = 0;
    const bad: string[] = [];
    run(s, 120 * 8, (events) => events.forEach((e) => {
      if (e.type !== "plan") return;
      const isVehicle = e.plan.actorId.startsWith("v");
      isVehicle ? cars++ : people++;
      if (e.plan.action === "wait") return;
      if (!onGraph(isVehicle ? s.map.road : s.map.sidewalk, e.plan.path)) bad.push(`${e.plan.actorId} ${e.plan.action}`);
    }));
    expect(bad).toEqual([]);
    expect(people).toBeGreaterThan(50);
    expect(cars).toBeGreaterThan(2);
  });

  it("are interpolated by startAt, speed and path", () => {
    const plan: Plan = { id: "p", actorId: "c", action: "work", path: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }], startAt: 100, speed: 2, arriveAt: 110, until: 150, clip: "typing" };
    expect(positionAt(plan, 90)).toMatchObject({ x: 0, z: 0, phase: "wait" });
    expect(positionAt(plan, 102)).toMatchObject({ x: 4, z: 0, phase: "move" });
    expect(positionAt(plan, 107.5)).toMatchObject({ x: 10, z: 5, phase: "move" });
    expect(positionAt(plan, 120)).toMatchObject({ x: 10, z: 10, phase: "dwell" });
  });
});

describe("construction", () => {
  const site = (s: WorldState) => Object.values(s.sites)[0]!;

  it("moves a site through the stages toward the target, with trucks bringing materials, and opens it on acceptance", () => {
    const s = createWorld(8, { citizens: 30, startHour: 9 });
    const events: WorldEvent[] = [];
    const collect = (e: WorldEvent[]) => events.push(...e);
    collect(signal(s, { type: "task_dispatched", projectId: "p1", taskId: "T1", attemptId: "a1", title: "Login page" }).events);
    collect(signal(s, { type: "attempt_progress", attemptId: "a1", percent: 0.5 }).events);
    const id = site(s).id;
    expect(site(s).target).toBe(targetForPercent(0.5));
    run(s, 120 * 8, collect);
    expect(stagesOf(events, id)).toEqual(["foundation", "frame", "walls"]);
    expect(site(s).stageIndex).toBe(3);
    const trucks = events.filter((e) => e.type === "spawned" && e.kind === "vehicle");
    expect(trucks.length).toBeGreaterThanOrEqual(3);
    expect(Object.values(s.vehicles).filter((v) => v.kind === "truck")).toHaveLength(0);
    // Further work waits for Lane Pilot: nothing moves without a higher target.
    run(s, 600, collect);
    expect(site(s).stageIndex).toBe(3);
    collect(signal(s, { type: "accepted", attemptId: "a1" }).events);
    run(s, 120 * 14, collect); // the crew sleeps at night, so the opening may wait for the morning
    expect(events.some((e) => e.type === "site" && e.siteId === id && e.state === "opened")).toBe(true);
    expect(stagesOf(events, id).at(-1)).toBe("open");
    const building = Object.values(s.buildings).find((b) => b.siteId === id)!;
    expect(building.name).toBe("Login page");
    expect(s.plotBuilding[building.plotId]).toBe(building.id);
  });

  it("collapses on failure, sends a repair crew and goes on afterwards", () => {
    const s = createWorld(8, { citizens: 30, startHour: 9 });
    signal(s, { type: "task_dispatched", projectId: "p1", taskId: "T1", attemptId: "a1" });
    signal(s, { type: "attempt_progress", attemptId: "a1", percent: 0.5 });
    run(s, 120 * 8);
    const events: WorldEvent[] = [];
    events.push(...signal(s, { type: "failed", attemptId: "a1" }).events);
    expect(site(s).collapsed).toBe(true);
    expect(site(s).stageIndex).toBe(2);
    run(s, 60, (e) => events.push(...e));
    const repairing = Object.values(s.jobs).find((j) => j.kind === "repair")!;
    expect(repairing.crew.length).toBeGreaterThan(0);
    run(s, 600, (e) => events.push(...e));
    expect(events.some((e) => e.type === "site" && e.state === "repaired")).toBe(true);
    expect(site(s).collapsed).toBe(false);
    run(s, 120 * 3, (e) => events.push(...e));
    expect(site(s).stageIndex).toBe(3);
  });

  it("does not let a lower target undo progress and ignores unknown attempts", () => {
    const s = createWorld(8, { citizens: 12, startHour: 9 });
    signal(s, { type: "task_dispatched", projectId: "p1", taskId: "T1", attemptId: "a1" });
    signal(s, { type: "attempt_progress", attemptId: "a1", percent: 0.9 });
    signal(s, { type: "attempt_progress", attemptId: "a1", percent: 0.1 });
    expect(site(s).target).toBe(5);
    const r = signal(s, { type: "attempt_progress", attemptId: "nope", percent: 0.5 });
    expect(r.events.at(-1)).toMatchObject({ type: "signal", applied: false, note: "unknown attempt" });
  });
});

describe("lane pilot signals", () => {
  it("a project becomes a district, a retry of a task reuses its site", () => {
    const s = createWorld(2, { citizens: 12 });
    const r = signal(s, { type: "project_upserted", projectId: "proj", name: "Shop" });
    expect(r.events.map((e) => e.type)).toEqual(["district", "signal"]);
    const district = Object.values(s.districts)[0]!;
    expect(district.name).toBe("Shop");
    expect(s.map.blocks.find((b) => b.id === district.blockId)!.kind).toBe("free");
    signal(s, { type: "task_dispatched", projectId: "proj", taskId: "T1", attemptId: "a1" });
    signal(s, { type: "task_dispatched", projectId: "proj", taskId: "T1", attemptId: "a2" });
    expect(Object.keys(s.sites)).toHaveLength(1);
    expect(Object.values(s.sites)[0]!.attemptIds).toEqual(["a1", "a2"]);
    expect(s.map.plots[Object.values(s.sites)[0]!.plotId]!.blockId).toBe(district.blockId);
    // A second project gets its own block.
    signal(s, { type: "project_upserted", projectId: "other" });
    expect(Object.values(s.districts)[1]!.blockId).not.toBe(district.blockId);
    const unknown = applyLanePilotSignal(s, { type: "bogus" } as never);
    expect(unknown.events[0]).toMatchObject({ applied: false });
  });

  it("verification sends the inspector; passed and failed mark the site", () => {
    const s = createWorld(2, { citizens: 40, startHour: 9 });
    signal(s, { type: "task_dispatched", projectId: "p", taskId: "T", attemptId: "a" });
    signal(s, { type: "verification", attemptId: "a", phase: "started" });
    const inspector = Object.values(s.citizens).find((c) => c.role === "inspector")!;
    expect(inspector.plan?.action).toBe("inspect");
    run(s, 300);
    expect(Object.values(s.jobs).some((j) => j.kind === "inspect")).toBe(false);
    expect(inspector.jobId).toBeNull();
    expect(signal(s, { type: "verification", attemptId: "a", phase: "failed" }).events[0]).toMatchObject({ type: "site", state: "rejected" });
    expect(Object.values(s.sites)[0]!.rejected).toBe(true);
    signal(s, { type: "verification", attemptId: "a", phase: "passed" });
    expect(Object.values(s.sites)[0]!.approved).toBe(true);
  });

  it("self-repair sends a van that stays until the repair ends, then drives home", () => {
    const s = createWorld(2, { citizens: 20, startHour: 9 });
    signal(s, { type: "task_dispatched", projectId: "p", taskId: "T", attemptId: "a" });
    const r = signal(s, { type: "self_repair_started", id: "r1", attemptId: "a" });
    const van = Object.values(s.vehicles).find((v) => v.kind === "van")!;
    expect(r.events.some((e) => e.type === "spawned" && e.kind === "vehicle")).toBe(true);
    expect(van.plan?.clip).toBe("siren");
    run(s, 200);
    expect(s.vehicles[van.id]).toBeDefined();
    signal(s, { type: "self_repair_ended", id: "r1" });
    run(s, 200);
    expect(s.vehicles[van.id]).toBeUndefined();
    expect(Object.keys(s.calls)).toHaveLength(0);
  });

  it("a council session seats staff at the meeting table and releases them afterwards", () => {
    const s = createWorld(2, { citizens: 20, startHour: 10 });
    run(s, 200);
    const r = signal(s, { type: "council_started", councilId: "c1" });
    const started = r.events.find((e) => e.type === "meeting");
    expect(started).toMatchObject({ state: "started" });
    const ids = (started as Extract<WorldEvent, { type: "meeting" }>).citizenIds;
    expect(ids.length).toBeGreaterThanOrEqual(4);
    for (const id of ids) expect(s.pois[s.citizens[id]!.plan!.target!]!.kind).toBe("seat");
    run(s, 600);
    for (const id of ids) expect(s.citizens[id]!.plan!.action).toBe("meeting");
    signal(s, { type: "council_ended", councilId: "c1" });
    run(s, 300);
    for (const id of ids) expect(s.citizens[id]!.plan!.action).not.toBe("meeting");
  });
});

describe("scenarios", () => {
  it("ships four examples and validates documents", () => {
    expect(listScenarios().map((x) => x.id)).toEqual(expect.arrayContaining(["morning-commute", "lunch-rush", "evening-home", "delivery"]));
    expect(() => parseScenario({ id: "x", routines: [{ id: "r", hours: [1, 30], action: "eat", mode: "bias" }] })).toThrow(/hours/);
    expect(() => parseScenario({ id: "x", events: [{ id: "e", do: [{ type: "explode" }] }] })).toThrow(/effect type/);
    expect(parseScenario({ id: "ok", events: [{ id: "e", do: [{ type: "spawn_traffic" }] }] }).events).toHaveLength(1);
  });

  it("the commute puts cars on the road and lunch fills the cafes", () => {
    const s = createWorld(6, { citizens: 40, startHour: 7 });
    const kinds = new Set<string>();
    run(s, 120, (events) => events.forEach((e) => { if (e.type === "spawned" && e.kind === "vehicle") kinds.add(String((e.data as { kind: string }).kind)); }));
    expect(kinds.has("car")).toBe(true);
    run(s, 120 * 5.2); // 12:12
    const eating = Object.values(s.citizens).filter((c) => c.plan?.action === "eat" && s.pois[c.plan.target ?? ""]).length;
    expect(eating).toBeGreaterThan(8);
  });

  it("a scripted storm knocks a site down", () => {
    const s = createWorld(6, { citizens: 30, startHour: 9, scenarios: ["storm"] });
    signal(s, { type: "task_dispatched", projectId: "p", taskId: "T", attemptId: "a" });
    signal(s, { type: "attempt_progress", attemptId: "a", percent: 0.5 });
    let collapsed = false;
    run(s, 120 * 24 * 3, (events) => { if (events.some((e) => e.type === "site" && e.state === "collapsed")) collapsed = true; });
    expect(collapsed).toBe(true);
  });
});

describe("catch-up", () => {
  it("one long catch-up lands near many small steps", () => {
    const a = createWorld(31, { citizens: 80, startHour: 6 });
    const b = cloneState(a);
    for (const w of [a, b]) {
      signal(w, { type: "task_dispatched", projectId: "p", taskId: "T", attemptId: "a" });
      signal(w, { type: "attempt_progress", attemptId: "a", percent: 0.5 });
    }
    run(a, 120 * 10);
    catchUp(b, 120 * 10, 30);
    expect(Math.abs(a.time - b.time)).toBeLessThan(1e-6);
    const mean = (w: WorldState, k: keyof WorldState["citizens"][string]["needs"]) => Object.values(w.citizens).reduce((n, c) => n + c.needs[k], 0) / Object.keys(w.citizens).length;
    for (const k of ["energy", "hunger", "social", "fun", "work"] as const) expect(Math.abs(mean(a, k) - mean(b, k)), k).toBeLessThan(0.12);
    expect(Object.values(a.sites)[0]!.stageIndex).toBe(3);
    expect(Object.values(b.sites)[0]!.stageIndex).toBe(3);
    const working = (w: WorldState) => Object.values(w.citizens).filter((c) => c.plan?.action === "work").length / 80;
    expect(Math.abs(working(a) - working(b))).toBeLessThan(0.25);
  });
});

describe("snapshot", () => {
  it("is plain JSON, with the static map only on request", () => {
    const s = createWorld(1, { citizens: 10 });
    run(s, 100);
    const small = snapshot(s), full = snapshot(s, { withMap: true });
    expect(small.map).toBeUndefined();
    expect(full.map!.sidewalk.nodes.length).toBeGreaterThan(100);
    expect(JSON.parse(JSON.stringify(small))).toEqual(small);
    expect(Object.keys(small.citizens)).toHaveLength(10);
    expect(small.eventSeq).toBe(s.eventSeq);
  });
});

describe("performance", () => {
  it("steps one sim hour of a 200-citizen city in under a second", () => {
    const s = createWorld(7, { citizens: 200 });
    run(s, 600);
    const t0 = performance.now();
    run(s, 3600);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
