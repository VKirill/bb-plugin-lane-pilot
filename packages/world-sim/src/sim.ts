import { nodePoint, pathLength, pathToPoints, shortestPath } from "./graph";
import { nextId } from "./rng";
import type { ActionKind, Citizen, Graph, Plan, Vec, Vehicle, WorldEvent, WorldState } from "./types";

/** A world being advanced: the state (mutated in place) and the events produced so far. */
export type Sim = { s: WorldState; events: WorldEvent[] };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function emit(sim: Sim, event: DistributiveOmit<WorldEvent, "seq" | "t">): void {
  sim.events.push({ ...event, seq: ++sim.s.eventSeq, t: sim.s.time } as WorldEvent);
}

export const hourOf = (s: WorldState, time = s.time): number => (s.config.startHour + time / s.config.hourSeconds) % 24;
export const dayOf = (s: WorldState, time = s.time): number => Math.floor((s.config.startHour + time / s.config.hourSeconds) / 24);
/** Sim seconds in this many game hours. */
export const hours = (s: WorldState, h: number): number => h * s.config.hourSeconds;

export type PlanePose = { x: number; z: number; heading: number; phase: "wait" | "move" | "dwell" };

/** Where a plan puts its actor at time `t`: the same function a client uses to interpolate. */
export function positionAt(plan: Plan, t: number): PlanePose {
  const path = plan.path;
  const first = path[0]!;
  if (path.length < 2 || t >= plan.arriveAt) {
    const last = path[path.length - 1]!;
    const prev = path.length > 1 ? path[path.length - 2]! : last;
    return { x: last.x, z: last.z, heading: Math.atan2(last.x - prev.x, last.z - prev.z), phase: "dwell" };
  }
  if (t <= plan.startAt) return { x: first.x, z: first.z, heading: headingOf(path, 0), phase: "wait" };
  let remaining = (t - plan.startAt) * plan.speed;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (remaining <= len || i === path.length - 1) {
      const k = len > 0 ? Math.min(1, remaining / len) : 1;
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, heading: Math.atan2(b.x - a.x, b.z - a.z), phase: "move" };
    }
    remaining -= len;
  }
  const last = path[path.length - 1]!;
  return { x: last.x, z: last.z, heading: 0, phase: "dwell" };
}

function headingOf(path: Vec[], i: number): number {
  const a = path[i]!, b = path[i + 1] ?? a;
  return Math.atan2(b.x - a.x, b.z - a.z);
}

/** The part of a moving plan still ahead at time `t`, starting at the actor's present position. */
function remainingPath(plan: Plan, t: number): Vec[] {
  const here = positionAt(plan, t);
  let travelled = Math.max(0, (t - plan.startAt) * plan.speed);
  const out: Vec[] = [{ x: here.x, z: here.z }];
  for (let i = 1; i < plan.path.length; i++) {
    const a = plan.path[i - 1]!, b = plan.path[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (travelled >= len) { travelled -= len; continue; }
    travelled = 0;
    out.push(b);
  }
  return out;
}

export type PlanOptions = {
  action: ActionKind;
  clip: string;
  /** Sim seconds to stay after arriving. */
  dwell: number;
  target?: string;
  speed?: number;
  lateral?: number;
};

/** Gives an actor a plan to a node. A walk or drive in progress is finished first, so the path stays continuous. */
export function planTo(sim: Sim, actor: Citizen | Vehicle, graph: Graph, toNode: number, opts: PlanOptions): Plan {
  const s = sim.s;
  const speed = opts.speed ?? ("speed" in actor ? actor.speed : 6);
  const moving = actor.plan && actor.plan.arriveAt > s.time ? remainingPath(actor.plan, s.time) : [actor.pos];
  const nodes = shortestPath(graph, actor.node, toNode);
  const tail = nodes ? pathToPoints(graph, nodes).slice(1) : [nodePoint(graph, toNode)];
  const path = [...moving, ...tail];
  const arriveAt = s.time + pathLength(path) / speed;
  const plan: Plan = {
    id: nextId(s, "p"), actorId: actor.id, action: opts.action, path, startAt: s.time, speed, arriveAt,
    until: arriveAt + Math.max(0, opts.dwell), clip: opts.clip, ...(opts.target ? { target: opts.target } : {}), ...(opts.lateral ? { lateral: opts.lateral } : {}),
  };
  const end = path[path.length - 1]!;
  actor.plan = plan;
  actor.node = toNode;
  actor.pos = { x: end.x, z: end.z };
  emit(sim, { type: "plan", plan });
  return plan;
}

/** A plan that keeps the actor where it is for a while. */
export function waitPlan(sim: Sim, actor: Citizen | Vehicle, seconds: number, quiet = false): Plan {
  const s = sim.s;
  const here = actor.plan && actor.plan.arriveAt > s.time ? remainingPath(actor.plan, s.time).slice(-1)[0]! : actor.pos;
  const plan: Plan = { id: nextId(s, "p"), actorId: actor.id, action: "wait", path: [{ x: here.x, z: here.z }], startAt: s.time, speed: 1, arriveAt: s.time, until: s.time + seconds, clip: "idle" };
  actor.plan = plan;
  if (!quiet) emit(sim, { type: "plan", plan });
  return plan;
}

export const distance = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.z - b.z);
