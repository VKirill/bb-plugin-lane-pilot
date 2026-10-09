import { damageSite, missingStage, orderDelivery, randomSite, sitesNeedingMaterials } from "./construction";
import { spawnTraffic } from "./services";
import { nextRandom } from "./rng";
import { hourOf, hours, type Sim } from "./sim";
import {
  CHOSEN_ACTIONS, type ChosenAction, type Citizen, type CitizenFilter, type Condition, type Effect, type HourRange, type Routine, type Scenario, type ScriptedEvent, type WorldState,
} from "./types";
import morningCommute from "./scenarios/morning-commute.json";
import lunchRush from "./scenarios/lunch-rush.json";
import eveningHome from "./scenarios/evening-home.json";
import delivery from "./scenarios/delivery.json";
import storm from "./scenarios/storm.json";

/**
 * Scenarios are data: routines that bias or force what citizens choose at certain hours, and scripted events with
 * conditions and effects. They live as JSON next to this file; `parseScenario` checks a document before it is used.
 */

const OPS = new Set(["<", "<=", ">", ">=", "=="]);
const FACTS = new Set(["hour", "sitesNeedingMaterials", "openSites", "idleCitizens", "vehicles", "chance"]);
const EFFECTS = new Set(["delivery", "spawn_traffic", "damage_site", "force_action"]);

function fail(where: string, what: string): never { throw new Error(`scenario ${where}: ${what}`); }
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function hourRange(v: unknown, where: string): HourRange {
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "number" || typeof v[1] !== "number" || v[0] < 0 || v[0] > 24 || v[1] < 0 || v[1] > 24) fail(where, "hours must be [from, to] within 0..24");
  return [v[0], v[1]];
}

function chosen(v: unknown, where: string): ChosenAction {
  if (typeof v !== "string" || !(CHOSEN_ACTIONS as readonly string[]).includes(v)) fail(where, `action must be one of ${CHOSEN_ACTIONS.join(", ")}`);
  return v as ChosenAction;
}

export function parseScenario(data: unknown): Scenario {
  if (!isRecord(data) || typeof data.id !== "string" || !data.id) fail("?", "id is required");
  const id = data.id as string;
  const routines = (Array.isArray(data.routines) ? data.routines : []).map((r, i): Routine => {
    const where = `${id}.routines[${i}]`;
    if (!isRecord(r) || typeof r.id !== "string") fail(where, "id is required");
    if (r.mode !== "bias" && r.mode !== "force") fail(where, "mode must be bias or force");
    return { id: r.id as string, hours: hourRange(r.hours, where), action: chosen(r.action, where), mode: r.mode,
      ...(isRecord(r.who) ? { who: r.who as CitizenFilter } : {}), ...(typeof r.weight === "number" ? { weight: r.weight } : {}), ...(typeof r.chance === "number" ? { chance: r.chance } : {}) };
  });
  const events = (Array.isArray(data.events) ? data.events : []).map((e, i): ScriptedEvent => {
    const where = `${id}.events[${i}]`;
    if (!isRecord(e) || typeof e.id !== "string") fail(where, "id is required");
    const conds = (Array.isArray(e.if) ? e.if : []).map((c): Condition => {
      if (!isRecord(c) || typeof c.fact !== "string" || !FACTS.has(c.fact) || typeof c.value !== "number") fail(where, "bad condition");
      if (c.fact !== "chance" && (typeof c.op !== "string" || !OPS.has(c.op))) fail(where, "condition needs an op");
      return c as unknown as Condition;
    });
    const effects = (Array.isArray(e.do) ? e.do : []).map((x): Effect => {
      if (!isRecord(x) || typeof x.type !== "string" || !EFFECTS.has(x.type)) fail(where, `effect type must be one of ${[...EFFECTS].join(", ")}`);
      if (x.type === "force_action") { chosen(x.action, where); if (typeof x.forHours !== "number") fail(where, "force_action needs forHours"); }
      return x as unknown as Effect;
    });
    if (!effects.length) fail(where, "an event needs at least one effect");
    return { id: e.id as string, ...(e.hours ? { hours: hourRange(e.hours, where) } : {}), ...(typeof e.cooldownHours === "number" ? { cooldownHours: e.cooldownHours } : {}), ...(conds.length ? { if: conds } : {}), do: effects };
  });
  return { id, title: typeof data.title === "string" ? data.title : id, routines, events };
}

const registry = new Map<string, Scenario>();
export function registerScenario(data: unknown): Scenario {
  const scenario = parseScenario(data);
  registry.set(scenario.id, scenario);
  return scenario;
}
for (const doc of [morningCommute, lunchRush, eveningHome, delivery, storm]) registerScenario(doc);

export const DEFAULT_SCENARIOS = ["morning-commute", "lunch-rush", "evening-home", "delivery"];
export const listScenarios = (): Scenario[] => [...registry.values()];

const active = (s: WorldState): Scenario[] => s.config.scenarios.map((id) => registry.get(id)).filter((x): x is Scenario => Boolean(x));

export const inHours = (hour: number, [from, to]: HourRange): boolean => (from <= to ? hour >= from && hour < to : hour >= from || hour < to);

export function matches(s: WorldState, c: Citizen, f: CitizenFilter | undefined | null): boolean {
  if (!f) return true;
  if (f.role && !(Array.isArray(f.role) ? f.role : [f.role]).includes(c.role)) return false;
  if (f.hasWork !== undefined && (c.workId !== null) !== f.hasWork) return false;
  if (f.hasDesk !== undefined && (c.deskPoi !== null) !== f.hasDesk) return false;
  if (f.workKind && (!c.workId || s.buildings[c.workId]?.kind !== f.workKind)) return false;
  return true;
}

/** Extra utility the active scenarios add to an action for this citizen now. */
export function routineBias(s: WorldState, c: Citizen, action: ChosenAction, hour: number): number {
  let bias = 0;
  for (const sc of active(s)) for (const r of sc.routines) {
    if (r.mode === "bias" && r.action === action && inHours(hour, r.hours) && matches(s, c, r.who)) bias += r.weight ?? 1;
  }
  return bias;
}

/** An action a `force` routine or a scripted event demands of this citizen right now, if any. */
export function forcedAction(s: WorldState, c: Citizen, hour: number): ChosenAction | null {
  for (const f of s.scenario.forced) if (s.time < f.until && matches(s, c, f.filter)) return f.action;
  for (const sc of active(s)) for (const r of sc.routines) {
    if (r.mode !== "force" || !inHours(hour, r.hours) || !matches(s, c, r.who)) continue;
    if (nextRandom(s) < (r.chance ?? 1)) return r.action;
  }
  return null;
}

const compare = (a: number, op: string, b: number) => (op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : a === b);

function holds(sim: Sim, c: Condition, hour: number): boolean {
  const s = sim.s;
  if (c.fact === "chance") return nextRandom(s) < c.value;
  const value = c.fact === "hour" ? hour
    : c.fact === "sitesNeedingMaterials" ? sitesNeedingMaterials(s).length
    : c.fact === "openSites" ? Object.values(s.sites).filter((x) => x.stageIndex < 6).length
    : c.fact === "idleCitizens" ? Object.values(s.citizens).filter((x) => !x.jobId && x.plan?.action === "wait").length
    : Object.keys(s.vehicles).length;
  return compare(value, c.op, c.value);
}

function apply(sim: Sim, effect: Effect): void {
  const s = sim.s;
  switch (effect.type) {
    case "delivery": {
      // The look-ahead run: bring the next missing stage's materials to the site that has waited longest.
      const site = sitesNeedingMaterials(s).sort((a, b) => a.createdAt - b.createdAt)[0];
      const stage = site ? missingStage(site, true) : null;
      if (site && stage !== null) orderDelivery(sim, site, stage);
      return;
    }
    case "spawn_traffic": spawnTraffic(sim, effect.kind ?? "car", effect.count ?? 1); return;
    case "damage_site": { const site = randomSite(s); if (site) damageSite(sim, site); return; }
    case "force_action": s.scenario.forced.push({ filter: effect.who ?? null, action: effect.action, until: s.time + hours(s, effect.forHours) }); return;
  }
}

/** Evaluates scripted events; called a few times a sim minute, not every step. */
export function runScenarioEvents(sim: Sim): void {
  const s = sim.s;
  const hour = hourOf(s);
  s.scenario.forced = s.scenario.forced.filter((f) => s.time < f.until);
  for (const sc of active(s)) for (const e of sc.events) {
    if (e.hours && !inHours(hour, e.hours)) continue;
    const last = s.scenario.lastFired[`${sc.id}/${e.id}`];
    if (last !== undefined && e.cooldownHours && s.time - last < hours(s, e.cooldownHours)) continue;
    if (e.if && !e.if.every((c) => holds(sim, c, hour))) continue;
    s.scenario.lastFired[`${sc.id}/${e.id}`] = s.time;
    for (const effect of e.do) apply(sim, effect);
  }
}
