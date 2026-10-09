import { updateNeeds, decide } from "./ai";
import { addBuilding } from "./buildings";
import { updateConstruction } from "./construction";
import { generateMap } from "./map";
import { nextId, nextRandom, pick, randRange, shuffle } from "./rng";
import { DEFAULT_SCENARIOS, runScenarioEvents } from "./scenarios";
import { updateServices } from "./services";
import { dayOf, hourOf, hours, planTo, waitPlan, type Sim } from "./sim";
import {
  WORLD_SCHEMA_VERSION, type Building, type BuildingKind, type Citizen, type CitizenRole, type Needs, type StepResult, type WorldConfig, type WorldMap, type WorldState,
} from "./types";

export type WorldOptions = { citizens?: number; scenarios?: string[]; startHour?: number; hourSeconds?: number };

const FIRST = ["Ada", "Boris", "Clara", "Dmitri", "Elena", "Felix", "Greta", "Hugo", "Irina", "Jonas", "Katya", "Leo", "Maya", "Nikolai", "Olga", "Pavel", "Quinn", "Rita", "Sven", "Tanya", "Uma", "Viktor", "Wanda", "Yuri", "Zoe", "Anton", "Bella", "Cyrus", "Dana", "Egor", "Faye", "Gleb", "Hana", "Igor", "Jana", "Kirill", "Lena", "Misha", "Nora", "Oleg"];
const LAST = ["Ash", "Birch", "Cole", "Dune", "Elm", "Fox", "Gray", "Hale", "Ives", "Jay", "Kerr", "Lake", "Marsh", "North", "Oak", "Park"];
const CAFES = ["Aurora", "Blue Door", "Copper Pot", "Daily Bean", "Evergreen"];
const SHOPS = ["Corner Market", "Paper & Pen", "Green Grocer", "Hardware", "Bookshop", "Bakery", "Flowers", "Tool Shed"];
const FIXED_STEP = 1;
const SCENARIO_EVERY = 15;
const MAX_CATCH_UP = 7 * 24 * 3600;

/** A new world: the starter city, its buildings and a population waking up around the office. */
export function createWorld(seed: number, options: WorldOptions = {}): WorldState {
  const config: WorldConfig = { hourSeconds: options.hourSeconds ?? 120, fixedStep: FIXED_STEP, scenarios: options.scenarios ?? DEFAULT_SCENARIOS, startHour: options.startHour ?? 6 };
  const map: WorldMap = generateMap();
  const s: WorldState = {
    schema: WORLD_SCHEMA_VERSION, seed, rng: seed >>> 0, config, time: 0, tick: 0, carry: 0, counters: {}, eventSeq: 0, map,
    citizens: {}, vehicles: {}, buildings: {}, pois: {}, plotBuilding: {}, plotSite: {}, plotDistrict: {}, districts: {}, sites: {}, jobs: {}, meetings: {},
    projects: {}, attempts: {}, tasks: {}, poiLoad: {}, calls: {}, scenario: { lastFired: {}, forced: [], lastCheck: 0 }, rev: 0,
  };
  const sim: Sim = { s, events: [] };
  populateBuildings(sim);
  populateCitizens(sim, options.citizens ?? 24);
  sim.events.length = 0;
  s.eventSeq = 0;
  return s;
}

function populateBuildings(sim: Sim): void {
  const s = sim.s;
  const plots = Object.values(s.map.plots);
  const commercial = shuffle(s, plots.filter((p) => p.zone === "commercial"));
  const kinds: BuildingKind[] = commercial.map((_, i) => (i % 8 === 0 || i % 8 === 3 || i % 8 === 6 ? "cafe" : "shop"));
  const cafeNames = shuffle(s, CAFES), shopNames = shuffle(s, SHOPS);
  commercial.forEach((plot, i) => addBuilding(sim, { plotId: plot.id, kind: kinds[i]!, name: kinds[i] === "cafe" ? `Cafe ${cafeNames.shift() ?? i}` : (shopNames.shift() ?? `Shop ${i}`) }));
  for (const plot of plots) {
    if (plot.zone === "residential") addBuilding(sim, { plotId: plot.id, kind: "house", name: `House ${plot.id}` });
    else if (plot.zone === "office") addBuilding(sim, { plotId: plot.id, kind: "office", name: "Lane Pilot office" });
    else if (plot.zone === "park") addBuilding(sim, { plotId: plot.id, kind: "park", name: "Central park" });
    else if (plot.zone === "industrial") addBuilding(sim, { plotId: plot.id, kind: plot.id === s.map.depotPlotId ? "depot" : "warehouse", name: plot.id === s.map.depotPlotId ? "Depot" : `Warehouse ${plot.id}` });
  }
}

function populateCitizens(sim: Sim, count: number): void {
  const s = sim.s;
  const byKind = (kind: BuildingKind): Building[] => Object.values(s.buildings).filter((b) => b.kind === kind);
  const homes = shuffle(s, byKind("house"));
  const office = byKind("office")[0]!;
  const depot = byKind("depot")[0]!;
  const shops = shuffle(s, [...byKind("cafe"), ...byKind("shop")]);
  const desks = office.poiIds.filter((id) => s.pois[id]!.kind === "desk");
  const builders = Math.max(0, Math.min(24, count >= 8 ? Math.max(3, Math.round(count * 0.2)) : 0));
  const inspectors = count >= 12 ? Math.max(1, Math.round(count / 30)) : 0;
  const staff = Math.min(desks.length, Math.round(count * 0.35));
  const clerks = Math.min(shops.length, Math.round(Math.max(0, count - staff - builders - inspectors) * 0.6));
  const plan: Array<{ role: CitizenRole; workId: string | null; desk: string | null }> = [];
  for (let i = 0; i < staff; i++) plan.push({ role: "worker", workId: office.id, desk: desks[i]! });
  for (let i = 0; i < builders; i++) plan.push({ role: "builder", workId: depot.id, desk: null });
  for (let i = 0; i < inspectors; i++) plan.push({ role: "inspector", workId: depot.id, desk: null });
  for (let i = 0; i < clerks; i++) plan.push({ role: "worker", workId: shops[i]!.id, desk: null });
  while (plan.length < count) plan.push({ role: "resident", workId: null, desk: null });
  plan.length = count;
  plan.forEach((spec, i) => {
    const home = homes[i % homes.length]!;
    const bed = s.pois[home.poiIds[0]!]!;
    const needs: Needs = { energy: randRange(s, 0.55, 1), hunger: randRange(s, 0.6, 1), social: randRange(s, 0.4, 1), fun: randRange(s, 0.4, 1), work: randRange(s, 0.6, 1) };
    const c: Citizen = {
      id: nextId(s, "c"), name: `${pick(s, FIRST)} ${pick(s, LAST)}`, role: spec.role, look: Math.floor(nextRandom(s) * 8), homeId: home.id, workId: spec.workId, deskPoi: spec.desk,
      speed: randRange(s, 1.35, 1.75), pos: { x: bed.x, z: bed.z }, node: bed.node, needs, plan: null, jobId: null, poi: null,
    };
    s.citizens[c.id] = c;
    // Everyone starts asleep or waking; the first decisions are spread over two minutes so the city does not move in lockstep.
    waitPlan(sim, c, randRange(s, 0, 120), true);
  });
}

/** One tick of `dt` sim seconds. */
function tick(sim: Sim, dt: number): void {
  const s = sim.s;
  s.time += dt;
  s.tick++;
  const hour = hourOf(s);
  for (const c of Object.values(s.citizens)) updateNeeds(s, c, dt, hour);
  if (s.time - s.scenario.lastCheck >= SCENARIO_EVERY) { s.scenario.lastCheck = s.time; runScenarioEvents(sim); }
  updateConstruction(sim, dt);
  updateServices(sim);
  for (const c of Object.values(s.citizens)) {
    if (c.jobId) {
      // A crew or a meeting holds its place without the citizen deciding; the plan is renewed before it lapses.
      const p = c.plan;
      if (p && p.until <= s.time + 5 && s.time >= p.arriveAt && (p.action === "build" || p.action === "repair" || p.action === "meeting")) {
        planTo(sim, c, s.map.sidewalk, c.node, { action: p.action, clip: p.clip, dwell: hours(s, 6), ...(p.target ? { target: p.target } : {}) });
      }
      continue;
    }
    if (!c.plan || s.time >= c.plan.until) decide(sim, c);
  }
}

/** Advances the world by `dtSeconds` in fixed steps (the remainder carries over). Mutates and returns the same state. */
export function step(state: WorldState, dtSeconds: number): StepResult {
  const sim: Sim = { s: state, events: [] };
  state.carry += dtSeconds;
  const fixed = state.config.fixedStep;
  while (state.carry >= fixed - 1e-9) { tick(sim, fixed); state.carry -= fixed; }
  return { state, events: sim.events };
}

/**
 * Brings a world that was not running forward by `elapsedSeconds` in coarse steps of at most `maxStep` (a hub restart).
 * Events are not returned: viewers fetch a fresh snapshot afterwards. Capped at a week.
 */
export function catchUp(state: WorldState, elapsedSeconds: number, maxStep = 30): StepResult {
  const sim: Sim = { s: state, events: [] };
  let left = Math.min(Math.max(0, elapsedSeconds), MAX_CATCH_UP);
  const size = Math.max(state.config.fixedStep, maxStep);
  while (left > 1e-9) {
    const dt = Math.min(size, left);
    tick(sim, dt);
    left -= dt;
  }
  sim.events.length = 0;
  return { state, events: [] };
}

export const cloneState = (state: WorldState): WorldState => JSON.parse(JSON.stringify(state)) as WorldState;

/** JSON of the world without the map: the map is the same for every world of this schema and is generated again on load. */
export const serializeWorld = (state: WorldState): string => JSON.stringify({ ...state, map: undefined });

export function parseWorld(json: string): WorldState {
  const data = JSON.parse(json) as WorldState;
  if (!data || typeof data !== "object" || data.schema !== WORLD_SCHEMA_VERSION) throw new Error(`world schema ${String((data as { schema?: unknown })?.schema)} is not ${WORLD_SCHEMA_VERSION}`);
  data.map = generateMap();
  return data;
}

// ---- client view ----

export type WorldSnapshot = {
  schema: number;
  seed: number;
  time: number;
  tick: number;
  /** Game hour 0..24 and day number, for lighting and clocks. */
  hour: number;
  day: number;
  hourSeconds: number;
  /** Sequence number of the last event already reflected in this snapshot. */
  eventSeq: number;
  map?: WorldMap;
  citizens: Record<string, Pick<Citizen, "id" | "name" | "role" | "look" | "speed" | "pos" | "needs" | "plan" | "workId" | "homeId">>;
  vehicles: WorldState["vehicles"];
  buildings: WorldState["buildings"];
  pois: WorldState["pois"];
  districts: WorldState["districts"];
  sites: WorldState["sites"];
  meetings: WorldState["meetings"];
};

/** What a browser needs to draw the world now. The map is static: ask for it once (`withMap`). Serialise before the next step. */
export function snapshot(state: WorldState, options: { withMap?: boolean } = {}): WorldSnapshot {
  const citizens: WorldSnapshot["citizens"] = {};
  for (const c of Object.values(state.citizens)) {
    citizens[c.id] = { id: c.id, name: c.name, role: c.role, look: c.look, speed: c.speed, pos: c.pos, needs: { ...c.needs }, plan: c.plan, workId: c.workId, homeId: c.homeId };
  }
  return {
    schema: state.schema, seed: state.seed, time: state.time, tick: state.tick, hour: hourOf(state), day: dayOf(state), hourSeconds: state.config.hourSeconds, eventSeq: state.eventSeq,
    ...(options.withMap ? { map: state.map } : {}),
    citizens, vehicles: state.vehicles, buildings: state.buildings, pois: state.pois, districts: state.districts, sites: state.sites, meetings: state.meetings,
  };
}
