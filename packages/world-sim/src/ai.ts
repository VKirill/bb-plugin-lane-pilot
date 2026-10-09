import { buildingsOf, releasePoi, reservePoi } from "./buildings";
import { forcedAction, routineBias } from "./scenarios";
import { nextRandom, randRange } from "./rng";
import { distance, hourOf, hours, planTo, waitPlan, type Sim } from "./sim";
import { CHOSEN_ACTIONS, type ActionKind, type ChosenAction, type Citizen, type Needs, type Poi, type WorldState } from "./types";

/** Needs lose this much per game hour. `work` only falls in working hours, and only for citizens with a workplace. */
export const DECAY_PER_HOUR: Needs = { energy: 0.045, hunger: 0.12, social: 0.055, fun: 0.055, work: 0.1 };
/** What an action adds per game hour while the citizen is at its destination, on top of the decay. */
export const RESTORE_PER_HOUR: Partial<Record<ActionKind, Partial<Needs>>> = {
  work: { work: 0.5 },
  eat: { hunger: 1.4 },
  chat: { social: 0.9, fun: 0.15 },
  rest: { energy: 0.12, fun: 0.05 },
  sleep: { energy: 0.23 },
  park: { fun: 0.55, social: 0.12, energy: 0.04 },
  shop: { fun: 0.45, hunger: 0.05 },
  build: { work: 0.4 },
  repair: { work: 0.4 },
  inspect: { work: 0.4 },
  meeting: { work: 0.3, social: 0.1 },
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const isWorkHour = (h: number) => h >= 8 && h < 18;

/** One simulation step of a citizen's needs. */
export function updateNeeds(s: WorldState, c: Citizen, dt: number, hour: number): void {
  const dtH = dt / s.config.hourSeconds;
  const plan = c.plan;
  const at = plan && s.time > plan.arriveAt ? plan.action : null;
  const restore = at ? RESTORE_PER_HOUR[at] : undefined;
  const slow = at === "sleep" ? 0.3 : 1;
  const n = c.needs;
  for (const key of ["energy", "hunger", "social", "fun"] as const) {
    n[key] = clamp01(n[key] - DECAY_PER_HOUR[key] * (key === "energy" ? 1 : slow) * dtH + (restore?.[key] ?? 0) * dtH);
  }
  const duty = c.workId && isWorkHour(hour) ? DECAY_PER_HOUR.work * slow : 0;
  n.work = clamp01(n.work - duty * dtH + (restore?.work ?? 0) * dtH);
}

type Option = { action: ChosenAction; poi: Poi; clip: string; score: number; dwellHours: [number, number]; planAction: ActionKind };

const weights = (n: Needs, hour: number): Record<ChosenAction, number> => {
  const day = hour >= 7 && hour < 20 ? 1 : 0.15;
  const lunch = hour >= 11 && hour < 14 ? 1.4 : 1;
  const night = hour >= 22 || hour < 6 ? 2.5 : 1;
  return {
    work: (1 - n.work) * 1.6 * (isWorkHour(hour) ? 1 : hour >= 7 && hour < 19 ? 0.5 : 0.05),
    eat: 1.8 * (1 - n.hunger) ** 2 * lunch,
    rest: 1.5 * (1 - n.energy) ** 2 * night,
    chat: 0.9 * (1 - n.social) ** 1.5 * day,
    park: 0.8 * (1 - n.fun) ** 1.5 * (hour >= 8 && hour < 19 ? 1 : 0.2),
    shop: 0.55 * (1 - n.fun) * (hour >= 9 && hour < 20 ? 1 : 0),
  };
};

/** Picks the point with the best score among candidates (distance plus how many are already there, minus noise). */
function best(s: WorldState, from: { x: number; z: number }, pois: Poi[], loadWeight: number): { poi: Poi; dist: number } | null {
  let pickBest: { poi: Poi; dist: number; score: number } | null = null;
  for (const poi of pois) {
    const dist = distance(from, poi);
    const score = dist + (s.poiLoad[poi.id] ?? 0) * loadWeight + nextRandom(s) * 4;
    if (!pickBest || score < pickBest.score) pickBest = { poi, dist, score };
  }
  return pickBest;
}

function poisOf(s: WorldState, buildingIds: Iterable<string>, kinds: readonly string[]): Poi[] {
  const out: Poi[] = [];
  for (const id of buildingIds) {
    const b = s.buildings[id];
    if (!b) continue;
    for (const pid of b.poiIds) { const p = s.pois[pid]!; if (kinds.includes(p.kind)) out.push(p); }
  }
  return out;
}

const idsOf = (s: WorldState, kind: Parameters<typeof buildingsOf>[1]) => buildingsOf(s, kind).map((b) => b.id);

function candidates(s: WorldState, c: Citizen, action: ChosenAction, hour: number): Poi[] {
  switch (action) {
    case "work": {
      if (c.deskPoi) return s.pois[c.deskPoi] ? [s.pois[c.deskPoi]!] : [];
      return c.workId ? poisOf(s, [c.workId], ["work"]) : [];
    }
    case "eat": {
      const cafes = poisOf(s, idsOf(s, "cafe"), ["table"]);
      const home = poisOf(s, [c.homeId], ["table"]);
      const office = c.workId && s.buildings[c.workId]?.kind === "office" ? poisOf(s, [c.workId], ["stool", "coffee"]) : [];
      // Evenings are for home; by day a cafe or the office kitchen is nearer to where people are.
      return hour >= 19 || hour < 7 ? [...home, ...(hour < 21 ? cafes : [])] : [...cafes, ...office, ...home];
    }
    case "rest": return poisOf(s, [c.homeId], hour >= 21 || hour < 6 ? ["bed"] : ["sofa"]);
    case "chat": return poisOf(s, [...idsOf(s, "cafe"), ...idsOf(s, "office"), ...idsOf(s, "park")], ["chat", "water", "bench"]);
    case "park": return poisOf(s, idsOf(s, "park"), ["bench", "stroll"]);
    case "shop": return poisOf(s, idsOf(s, "shop"), ["shop"]);
  }
}

const DWELL: Record<ChosenAction, [number, number]> = {
  work: [3, 4.5], eat: [0.4, 0.7], chat: [0.3, 0.6], rest: [0.8, 1.5], park: [0.7, 1.4], shop: [0.4, 0.8],
};

/** Chooses what to do next by utility, among the actions that have somewhere to go. */
export function decide(sim: Sim, c: Citizen): void {
  const s = sim.s;
  releasePoi(s, c);
  const hour = hourOf(s);
  const w = weights(c.needs, hour);
  const options: Option[] = [];
  for (const action of CHOSEN_ACTIONS) {
    if (action === "work" && !c.workId) continue;
    const found = best(s, c.pos, candidates(s, c, action, hour), action === "chat" ? -8 : 6);
    if (!found) continue;
    const travelHours = found.dist / c.speed / s.config.hourSeconds;
    const planAction: ActionKind = action === "rest" && found.poi.kind === "bed" ? "sleep" : action;
    options.push({ action, poi: found.poi, clip: found.poi.clip, planAction, dwellHours: DWELL[action],
      score: w[action] + routineBias(s, c, action, hour) - 0.5 * travelHours + nextRandom(s) * 0.12 });
  }
  const forced = forcedAction(s, c, hour);
  const choice = (forced && options.find((o) => o.action === forced)) || options.sort((a, b) => b.score - a.score)[0];
  if (!choice) { waitPlan(sim, c, 30, true); return; }
  let dwell = hours(s, randRange(s, choice.dwellHours[0], choice.dwellHours[1]));
  if (choice.planAction === "sleep") {
    const untilMorning = (7 - hour + 24) % 24;
    dwell = hours(s, Math.min(9, Math.max(3, untilMorning)) + randRange(s, 0, 0.5));
  }
  reservePoi(s, c, choice.poi);
  planTo(sim, c, s.map.sidewalk, choice.poi.node, { action: choice.planAction, clip: choice.clip, dwell, target: choice.poi.id });
}
