import type { Plan, Vec } from "./types";

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

